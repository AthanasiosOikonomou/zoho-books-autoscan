'use strict';

/**
 * Phase 2 — line-level matching between the invoice lines Claude read and the PO lines in Books.
 *
 * Keys per PO line (any may be missing): the item custom field "Supplier Reference" (the supplier's own
 * code, printed on the PO), the item's MPN, the item SKU, the PO line item_code. Codes are compared
 * normalised: case-insensitive, with spaces, dots, dashes, slashes and underscores removed, so
 * `ZK410-KIT` == `ZK410KIT` and `7.204.15P` == `7204 15P`.
 *
 * Carriage lines on the PO (by name, or the configured carriage item) are never product lines; the
 * invoice's carriage total is compared with them under the vendor's rule.
 *
 * Pure: no I/O. Returns everything the bill builder needs (quantities + rates per PO line, carriage line).
 */
const { round2 } = require('../util/money');

const CARRIAGE_RE = /\b(carriage|delivery|freight|shipping|postage|p&p|packing|surcharge|handling)\b/i;

function normCode(s) {
  return String(s === null || s === undefined ? '' : s).toUpperCase().replace(/[\s.\-_/\\()]/g, '');
}

/** Keys of one PO line, in order of preference. `item` (optional) is the Books item for MPN/SKU fallback. */
function poLineKeys(line, item, { supplierRefLabel = 'Supplier Reference' } = {}) {
  const keys = [];
  const push = (v, source) => { const n = normCode(v); if (n && !keys.some((k) => k.n === n)) keys.push({ n, raw: String(v), source }); };
  const want = supplierRefLabel.trim().toLowerCase();
  for (const f of line.item_custom_fields || []) if (String(f.label || '').trim().toLowerCase() === want) push(f.value, 'supplier_reference');
  if (item) {
    for (const f of item.custom_fields || []) if (String(f.label || '').trim().toLowerCase() === want) push(f.value, 'supplier_reference');
    push(item.mpn, 'mpn');
    push(item.sku, 'sku');
  }
  push(line.sku, 'sku');
  push(line.item_code, 'item_code');
  return keys;
}

function isCarriageLine(line, carriageItemId) {
  if (carriageItemId && String(line.item_id) === String(carriageItemId)) return true;
  return CARRIAGE_RE.test(`${line.name || ''} ${line.description || ''}`);
}

function remainingQty(line) {
  const q = Number(line.quantity) || 0;
  const billed = Number(line.quantity_billed) || 0;
  const cancelled = Number(line.quantity_cancelled) || 0;
  return round2(Math.max(0, q - billed - cancelled));
}

/**
 * @param {object} p
 * @param {object} p.extraction           Claude output (line_items, totals)
 * @param {object} p.po                   Books PO (line_items)
 * @param {Map}    p.items                item_id → Books item (optional, for MPN/SKU)
 * @param {object} p.vendorRule           { rule: 'Zero'|'Fixed'|'Ignore', tolerance }
 * @param {object} p.config               config.matching
 */
function matchLines({ extraction, po, items = new Map(), vendorRule = { rule: 'Zero', tolerance: 0 }, config }) {
  const cfg = {
    pricePct: Number(config.linePriceTolerancePct ?? 5),
    priceAbs: Number(config.linePriceToleranceAbs ?? 0.05),
    acceptLower: config.acceptLowerPrice !== false,
    totalTolerance: Number(config.totalTolerance ?? 1),
    carriageItemId: config.carriageItemId || null,
    supplierRefLabel: config.supplierRefLabel || 'Supplier Reference',
  };
  const notes = [];
  const problems = []; // { code, text }
  const poLines = (po.line_items || []).map((l) => ({ ...l, _carriage: isCarriageLine(l, cfg.carriageItemId) }));
  const productPo = poLines.filter((l) => !l._carriage);
  const carriagePo = poLines.filter((l) => l._carriage);
  const keyed = productPo.map((l) => ({ line: l, keys: poLineKeys(l, items.get(String(l.item_id)), cfg) }));

  if (!productPo.length) return { ok: false, fallback: 'totals', reason: { code: 'NO_MPN', text: 'PO has no product lines' }, notes };
  if (keyed.every((k) => !k.keys.length)) {
    return { ok: false, fallback: 'totals', reason: { code: 'NO_MPN', text: `no PO line carries a ${cfg.supplierRefLabel} / MPN / SKU — matched on totals instead` }, notes };
  }

  // ---- product lines
  const invLines = (extraction.line_items || []).filter((l) => Number(l.quantity) > 0 || Number(l.line_total) > 0);
  const matched = []; // { inv, po, qty, rate, poRate, priceDiffPct }
  const byPo = new Map(); // po line_item_id → accumulated qty
  for (const inv of invLines) {
    const code = normCode(inv.mpn);
    let hit = null; let via = null;
    if (code) {
      for (const k of keyed) { const key = k.keys.find((x) => x.n === code); if (key) { hit = k.line; via = key.source; break; } }
      if (!hit) { // tolerate a PO code that is a prefix/suffix of the invoice code or vice versa (pack sizes appended)
        for (const k of keyed) { const key = k.keys.find((x) => x.n.length >= 4 && (code.startsWith(x.n) || x.n.startsWith(code))); if (key) { hit = k.line; via = `${key.source}~`; break; } }
      }
    }
    if (!hit) {
      const keyless = keyed.filter((k) => !k.keys.length).map((k) => k.line.name);
      problems.push({ code: 'LINE_UNMATCHED', text: `"${inv.mpn || inv.description}" (qty ${inv.quantity}) is not on the PO${keyless.length ? ` — PO lines without a ${cfg.supplierRefLabel}/MPN: ${keyless.slice(0, 3).join('; ')}` : ''}` });
      continue;
    }
    const qty = Number(inv.quantity) || 0;
    const rate = Number.isFinite(Number(inv.unit_price)) ? Number(inv.unit_price) : (qty ? round2(Number(inv.line_total) / qty) : NaN);
    const poRate = Number(hit.rate);
    const prev = byPo.get(hit.line_item_id) || 0;
    byPo.set(hit.line_item_id, round2(prev + qty));
    const remaining = remainingQty(hit);
    if (round2(prev + qty) > remaining + 1e-9) {
      problems.push({ code: 'QTY_EXCEEDS', text: `${inv.mpn || hit.name}: invoiced ${round2(prev + qty)} but only ${remaining} remaining on the PO (ordered ${hit.quantity}, billed ${hit.quantity_billed || 0})` });
    }
    let priceOk = true; let priceNote = null;
    if (Number.isFinite(rate) && Number.isFinite(poRate) && poRate > 0) {
      const d = round2(rate - poRate);
      const tol = Math.max(cfg.priceAbs, round2(poRate * cfg.pricePct / 100));
      if (Math.abs(d) > tol) {
        if (d < 0 && cfg.acceptLower) priceNote = `${inv.mpn || hit.name}: invoiced at ${rate.toFixed(2)} vs PO ${poRate.toFixed(2)} (lower, accepted)`;
        else { priceOk = false; problems.push({ code: 'PRICE_MISMATCH', text: `${inv.mpn || hit.name}: unit price ${rate.toFixed(2)} vs PO ${poRate.toFixed(2)} (${d > 0 ? '+' : ''}${(d / poRate * 100).toFixed(1)}%, tolerance ±${cfg.pricePct}%)` }); }
      }
    }
    if (priceNote) notes.push(priceNote);
    matched.push({ inv, po: hit, qty, rate: Number.isFinite(rate) ? rate : poRate, poRate, via, priceOk, taxPct: Number(hit.tax_percentage) || 0 });
  }
  if (!matched.length && !problems.length) problems.push({ code: 'LINE_UNMATCHED', text: 'no product lines were read from the invoice' });

  // ---- carriage
  const invCarriage = round2(Math.abs(Number(extraction.totals && extraction.totals.carriage)) || 0);
  const poCarriage = round2(carriagePo.reduce((s, l) => s + (Number(l.rate) || 0) * (Number(l.quantity) || 0), 0));
  const carriage = { invoice: invCarriage, po: poCarriage, rule: vendorRule.rule, tolerance: vendorRule.tolerance, diff: round2(Math.abs(invCarriage - poCarriage)), ok: true, source: vendorRule.source };
  if (vendorRule.rule === 'Zero' && carriage.diff > 0.01) carriage.ok = false;
  if (vendorRule.rule === 'Fixed' && carriage.diff > vendorRule.tolerance + 1e-9) carriage.ok = false;
  if (!carriage.ok) problems.push({ code: 'CARRIAGE_MISMATCH', text: `carriage ${invCarriage.toFixed(2)} on the invoice vs ${poCarriage.toFixed(2)} on the PO (rule ${vendorRule.rule}${vendorRule.rule === 'Fixed' ? ` ±${vendorRule.tolerance.toFixed(2)}` : ''})` });
  const carriageTaxPct = carriagePo[0] ? Number(carriagePo[0].tax_percentage) || 0 : (matched[0] ? matched[0].taxPct : 20);

  // ---- expected totals (what the bill will be) vs the invoice
  const net = round2(matched.reduce((s, m) => s + m.qty * m.rate, 0) + invCarriage);
  const vat = round2(matched.reduce((s, m) => s + m.qty * m.rate * m.taxPct / 100, 0) + invCarriage * carriageTaxPct / 100);
  const gross = round2(net + vat);
  const invGross = Number(extraction.totals && extraction.totals.gross);
  const totalsDiff = Number.isFinite(invGross) ? round2(Math.abs(gross - invGross)) : NaN;
  if (!problems.length && Number.isFinite(totalsDiff) && totalsDiff > cfg.totalTolerance) {
    problems.push({ code: 'TOTAL_MISMATCH', text: `matched lines + carriage come to ${gross.toFixed(2)} but the invoice total is ${invGross.toFixed(2)} (diff ${totalsDiff.toFixed(2)})` });
  }

  const quantities = {}; const rates = {};
  for (const m of matched) { quantities[m.po.line_item_id] = round2((quantities[m.po.line_item_id] || 0) + m.qty); rates[m.po.line_item_id] = m.rate; }
  const partial = productPo.some((l) => remainingQty(l) > 0 && !(quantities[l.line_item_id] >= remainingQty(l)));
  const first = problems[0] || null;
  return {
    ok: !problems.length,
    reason: first ? { code: first.code, text: problems.length > 1 ? `${first.text}; +${problems.length - 1} more` : first.text } : null,
    problems, notes, matched: matched.map((m) => ({ code: m.inv.mpn, po_line: m.po.line_item_id, name: m.po.name, qty: m.qty, rate: m.rate, po_rate: m.poRate, via: m.via })),
    quantities, rates, partial,
    carriage: { ...carriage, taxPct: carriageTaxPct, poLineId: carriagePo[0] ? carriagePo[0].line_item_id : null },
    expected: { net, vat, gross, invoiceGross: invGross, diff: totalsDiff },
  };
}

module.exports = { matchLines, normCode, poLineKeys, isCarriageLine, remainingQty };
