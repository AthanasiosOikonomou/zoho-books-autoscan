'use strict';

/**
 * Phase 2 — line-level matching between the invoice lines Claude read and the PO lines in Books.
 *
 * Keys per PO line (any may be missing): the item custom field "Supplier Reference" (the supplier's own
 * code, printed on the PO), the item's MPN (`part_number` in the API), the item SKU, the PO line item_code. Codes are compared
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
  const push = (v, source) => {
    if (v === null || v === undefined || typeof v === 'object') return; // some organizations return item_code as {}
    const n = normCode(v); if (n && !keys.some((k) => k.n === n)) keys.push({ n, raw: String(v), source });
  };
  const want = supplierRefLabel.trim().toLowerCase();
  for (const f of line.item_custom_fields || []) if (String(f.label || '').trim().toLowerCase() === want) push(f.value, 'supplier_reference');
  if (item) {
    for (const f of item.custom_fields || []) if (String(f.label || '').trim().toLowerCase() === want) push(f.value, 'supplier_reference');
    push(item.mpn, 'mpn');
    push(item.part_number, 'mpn'); // the item's "MPN" field in the Books UI is `part_number` in the API
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

function numOrNaN(v) { return v === null || v === undefined || v === '' ? NaN : Number(v); }
function round4(n) { return Math.round((n + Number.EPSILON) * 10000) / 10000; }

/**
 * Pack ↔ each. The invoice line and the PO line carry the same code but count different units (6 EACH at 184.71
 * against 1 "box of 6" at 1108.26). Accepted only when it is the same money and a whole pack size, and the PO still
 * has those units: the invoice line total is a whole number of PO units to the penny (per unit), invoice quantity and
 * PO units differ by a whole factor ≥ 2, and the units are available. Anything else keeps the plain reading, which
 * then reports QTY_EXCEEDS / PRICE_MISMATCH as before.
 * @returns {{units:number, rate:number, factor:number}|null}
 */
function packUnits({ qty, lineTotal, poRate, available, priceAbs = 0.01 }) {
  if (!(qty > 0) || !(poRate > 0) || !Number.isFinite(lineTotal) || !(lineTotal > 0)) return null;
  const units = Math.round(lineTotal / poRate);
  if (units < 1 || units === qty) return null;
  if (Math.abs(lineTotal - units * poRate) > priceAbs * units + 1e-9) return null;
  const factor = qty > units ? qty / units : units / qty;
  if (Math.abs(factor - Math.round(factor)) > 1e-9 || Math.round(factor) < 2) return null;
  if (units > available + 1e-9) return null;
  return { units, rate: round4(lineTotal / units), factor: Math.round(factor) };
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
    pricePctDown: Number(config.linePriceTolerancePct ?? 5), // invoice below the PO price: billed at the invoice price up to this %
    pricePctUp: Number(config.linePriceToleranceUpPct ?? 0), // invoice above the PO price: 0 = every increase goes to review
    priceAbs: Number(config.linePriceToleranceAbs ?? 0.01), // penny rounding guard
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
  // A row printed at 0.00 (a courier name, a delivery instruction: 1 × 0.00) bills nothing: it is noted, never matched.
  const isZeroValue = (l) => l.line_total !== null && l.line_total !== undefined && Number(l.line_total) === 0 && !(Number(l.unit_price) > 0);
  const invLines = [];
  for (const l of extraction.line_items || []) {
    if (!(Number(l.quantity) > 0 || Number(l.line_total) > 0)) continue;
    if (isZeroValue(l)) { notes.push(`"${l.mpn || l.description}": zero-value row ignored`); continue; }
    invLines.push(l);
  }
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
    let qty = Number(inv.quantity) || 0;
    const label = inv.mpn || hit.name;
    const lineTotal = numOrNaN(inv.line_total);
    let rate = numOrNaN(inv.unit_price);
    // The line total is what is paid. A printed price that does not multiply up to it is quoted per another measure
    // (per litre, per 100, before a line discount) or was not printed at all: the unit price comes from the line total.
    if (qty > 0 && Number.isFinite(lineTotal) && (!Number.isFinite(rate) || Math.abs(round2(rate * qty) - lineTotal) > Math.max(0.02, 0.005 * qty))) {
      const implied = round4(lineTotal / qty);
      if (Number.isFinite(rate)) notes.push(`${label}: printed price ${rate.toFixed(2)} × ${qty} is not the line total ${lineTotal.toFixed(2)} — unit price taken from the line total (${implied.toFixed(2)})`);
      rate = implied;
    }
    const poRate = Number(hit.rate);
    const prev = byPo.get(hit.line_item_id) || 0;
    const remaining = remainingQty(hit);
    // Pack ↔ each: same code, but the supplier counts single units where the PO line is a pack (or the reverse).
    const pack = packUnits({ qty, lineTotal, poRate, available: round2(remaining - prev), priceAbs: cfg.priceAbs });
    if (pack) {
      notes.push(`${label}: invoiced ${qty} × ${Number.isFinite(rate) ? rate.toFixed(2) : '?'} = ${lineTotal.toFixed(2)}, the PO counts it ${pack.factor} to a ${qty > pack.units ? 'pack' : 'unit'} (${pack.units} × ${poRate.toFixed(2)}) — billed as ${pack.units} PO unit${pack.units === 1 ? '' : 's'}`);
      qty = pack.units; rate = pack.rate;
    }
    byPo.set(hit.line_item_id, round2(prev + qty));
    if (round2(prev + qty) > remaining + 1e-9) {
      problems.push({ code: 'QTY_EXCEEDS', text: `${inv.mpn || hit.name}: invoiced ${round2(prev + qty)} but only ${remaining} remaining on the PO (ordered ${hit.quantity}, billed ${hit.quantity_billed || 0})` });
    }
    let priceOk = true; let priceNote = null;
    if (Number.isFinite(rate) && Number.isFinite(poRate) && poRate > 0) {
      const d = round2(rate - poRate);
      const pct = `${d > 0 ? '+' : ''}${(d / poRate * 100).toFixed(1)}%`;
      const tolDown = Math.max(cfg.priceAbs, round2(poRate * cfg.pricePctDown / 100));
      const tolUp = Math.max(cfg.priceAbs, round2(poRate * cfg.pricePctUp / 100));
      if (d > tolUp) {
        priceOk = false;
        problems.push({ code: 'PRICE_MISMATCH', text: `${label}: unit price ${rate.toFixed(2)} vs PO ${poRate.toFixed(2)} (${pct}; ${cfg.pricePctUp > 0 ? `allowed up to +${cfg.pricePctUp}%` : 'price increases always go to review'})` });
      } else if (-d > tolDown) {
        priceOk = false;
        problems.push({ code: 'PRICE_MISMATCH', text: `${label}: unit price ${rate.toFixed(2)} vs PO ${poRate.toFixed(2)} (${pct}; allowed down to -${cfg.pricePctDown}%)` });
      } else if (Math.abs(d) > cfg.priceAbs + 1e-9) {
        priceNote = `${label}: invoiced at ${rate.toFixed(2)} vs PO ${poRate.toFixed(2)} (${pct}, billed at the invoice price)`;
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

module.exports = { matchLines, normCode, poLineKeys, isCarriageLine, remainingQty, packUnits };
