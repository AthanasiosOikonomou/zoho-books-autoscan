'use strict';

/**
 * Phase 2 — line-level matching between the invoice lines Claude read and the PO lines in Books.
 *
 * Keys per PO line (any may be missing): the item custom field "Supplier Reference" (the supplier's own
 * code, printed on the PO), the item's MPN (`part_number` in the API), the item SKU, the PO line item_code. Codes are compared
 * normalised: case-insensitive, with spaces, dots, dashes, slashes and underscores removed, so
 * `ZK410-KIT` == `ZK410KIT` and `7.204.15P` == `7204 15P`.
 *
 * A PO line whose item carries no supplier-side code (no Supplier Reference, no MPN) can still be matched by value:
 * exactly one such open line has the invoice line's unit price and enough quantity, no other invoice line could
 * take it, and the two descriptions share a word. Anything ambiguous stays LINE_UNMATCHED.
 *
 * Carriage lines on the PO (by name, or the configured carriage item) are never product lines; the
 * invoice's carriage is compared with what is still open on them: at or below the PO it is always accepted and
 * billed as invoiced (none invoiced → the PO's carriage line stays open for a separate carriage invoice), above
 * the PO the vendor's rule decides (Zero: never, Fixed: up to the tolerance, Ignore: always).
 *
 * A product surcharge on the invoice ("PRODUCT SURCHARGE 5%", "Order Surcharge") is not carriage: it is part of
 * the product price, spread over the product lines by value before the price check.
 *
 * Pack ↔ each allows for the supplier rounding its price per item to the penny: up to half a penny per item
 * (25 × 4.69 = 117.25 against a pack of 25 at 117.29).
 *
 * A kit the PO orders as one line may be invoiced as its separate parts: the invoice lines that match nothing else
 * are billed as the kit when together they make up the kit line still open on the PO (same price rule, one
 * candidate line only).
 *
 * Pure: no I/O. Returns everything the bill builder needs (quantities + rates per PO line, carriage line).
 */
const { round2 } = require('../util/money');

const CARRIAGE_RE = /\b(carriage|delivery|freight|shipping|postage|p&p|packing|surcharge|handling)\b/i;

// ---- what the invoice charges on top of the product lines: delivery (carriage) or a product surcharge.
// A charge is carriage unless its description says surcharge / levy WITHOUT naming the delivery — "PRODUCT
// SURCHARGE 5%", "Order Surcharge" are part of the product price; "Fuel surcharge", "Delivery surcharge" are carriage.
const SURCHARGE_RE = /\b(surcharge|levy)\b/i;
const DELIVERY_RE = /\b(carriage|delivery|deliveries|freight|shipping|shipment|postage|p\s?&\s?p|packing|packaging|handling|fuel|courier|pallet|transport|haulage|despatch|dispatch)\b/i;
function isProductSurcharge(description) {
  const d = String(description || '');
  return SURCHARGE_RE.test(d) && !DELIVERY_RE.test(d);
}

/**
 * Carriage and product surcharge of an invoice. With the charges listed one by one (`charges`, as the reader returns
 * them) each is classified by its printed description; an extraction that only has one carriage figure is all carriage.
 * @returns {{carriage:number, surcharge:number, surcharges:Array<{description:string, amount:number}>}}
 */
function splitCharges(extraction, { surchargeInPrice = true } = {}) {
  const total = round2(Math.abs(Number(extraction.totals && extraction.totals.carriage)) || 0);
  const list = (Array.isArray(extraction.charges) ? extraction.charges : [])
    .map((c) => ({ description: String((c && c.description) || ''), amount: round2(Math.abs(Number(c && c.amount)) || 0) }))
    .filter((c) => c.amount > 0);
  if (!surchargeInPrice || !list.length) return { carriage: total, surcharge: 0, surcharges: [] };
  const surcharges = list.filter((c) => isProductSurcharge(c.description));
  const delivery = list.filter((c) => !isProductSurcharge(c.description));
  return { carriage: round2(delivery.reduce((s, c) => s + c.amount, 0)), surcharge: round2(surcharges.reduce((s, c) => s + c.amount, 0)), surcharges };
}

// ---- descriptions: a value match must be confirmed by at least one shared word (sizes and pure numbers do not count)
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'per', 'pack', 'box', 'each', 'ltr', 'litre', 'litres', 'size', 'colour', 'color', 'length', 'profile', 'item', 'product']);
function words(s) {
  return new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !/^\d/.test(w) && !STOP_WORDS.has(w)));
}
function shareWord(a, b) {
  const wb = words(b);
  for (const w of words(a)) if (wb.has(w)) return true;
  return false;
}

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

// A kit line on the PO: its name says so ("... Resin Bound Kits: ..., KIT - Aggregate + Quartz + Binder").
const KIT_RE = /\bkits?\b/i;
function isKitLine(line) {
  return KIT_RE.test(`${line.name || ''} ${line.description || ''}`);
}

function isCarriageLine(line, carriageItemId) {
  if (carriageItemId && String(line.item_id) === String(carriageItemId)) return true;
  return CARRIAGE_RE.test(`${line.name || ''} ${line.description || ''}`);
}

/** A unit price for a message: pence, or four decimals when it is not a whole penny (a price that carries a surcharge share). */
function price(n) { return Math.abs(round2(n) - n) < 1e-9 ? n.toFixed(2) : n.toFixed(4); }
function numOrNaN(v) { return v === null || v === undefined || v === '' ? NaN : Number(v); }
function round4(n) { return Math.round((n + Number.EPSILON) * 10000) / 10000; }

/**
 * Pack ↔ each. The invoice line and the PO line carry the same code but count different units (6 EACH at 184.71
 * against 1 "box of 6" at 1108.26). Accepted only when it is the same money and a whole pack size, and the PO still
 * has those units: the invoice line total is a whole number of PO units to the penny (per unit), invoice quantity and
 * PO units differ by a whole factor ≥ 2, and the units are available. Anything else keeps the plain reading, which
 * then reports QTY_EXCEEDS / PRICE_MISMATCH as before.
 *
 * "The same money" allows for the price per item being rounded to the penny: up to `roundingPerItem` (half a penny)
 * per item on the side that counts single items — 25 × 4.69 = 117.25 is a pack of 25 at 117.29 (4p, within 12.5p).
 * `rounding` is that allowance per PO unit; the price check of the converted line uses it as its rounding guard.
 * @returns {{units:number, rate:number, factor:number, rounding:number}|null}
 */
function packUnits({ qty, lineTotal, poRate, available, priceAbs = 0.01, roundingPerItem = 0 }) {
  if (!(qty > 0) || !(poRate > 0) || !Number.isFinite(lineTotal) || !(lineTotal > 0)) return null;
  const units = Math.round(lineTotal / poRate);
  if (units < 1 || units === qty) return null;
  const allowed = Math.max(priceAbs * units, (Number(roundingPerItem) || 0) * Math.max(qty, units));
  if (Math.abs(lineTotal - units * poRate) > allowed + 1e-9) return null;
  const factor = qty > units ? qty / units : units / qty;
  if (Math.abs(factor - Math.round(factor)) > 1e-9 || Math.round(factor) < 2) return null;
  if (units > available + 1e-9) return null;
  return { units, rate: round4(lineTotal / units), factor: Math.round(factor), rounding: round4(allowed / units) };
}

/** The price band of one PO line: how far below / above the PO unit price an invoice price may be. */
function priceBand(poRate, cfg, guard = cfg.priceAbs) {
  return { down: Math.max(guard, round2(poRate * cfg.pricePctDown / 100)), up: Math.max(guard, round2(poRate * cfg.pricePctUp / 100)) };
}

function remainingQty(line) {
  const q = Number(line.quantity) || 0;
  const billed = Number(line.quantity_billed) || 0;
  const cancelled = Number(line.quantity_cancelled) || 0;
  return round2(Math.max(0, q - billed - cancelled));
}

/**
 * @param {object} p
 * @param {object} p.extraction           Claude output (line_items, totals, charges)
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
    carriageBelowPoOk: config.carriageBelowPoOk ?? true, // carriage at or below the PO is accepted under every vendor rule
    surchargeInPrice: config.surchargeInPrice ?? true, // a product surcharge is part of the product price, not carriage
    valueFallback: config.lineValueFallback ?? true, // PO lines without a supplier code may be matched by value
    packRoundingPerItem: Number(config.packRoundingPerItem ?? 0.005), // pack ↔ each: price per item rounded to the penny
    kitRule: config.kitRule ?? true, // a kit invoiced as its separate parts is billed as the kit line of the PO
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

  // ---- what the invoice charges on top of the product lines
  const charges = splitCharges(extraction, cfg);
  const invCarriage = charges.carriage;

  // ---- product lines
  // A row printed at 0.00 (a courier name, a delivery instruction: 1 × 0.00) bills nothing: it is noted, never matched.
  const isZeroValue = (l) => l.line_total !== null && l.line_total !== undefined && Number(l.line_total) === 0 && !(Number(l.unit_price) > 0);
  const invLines = [];
  for (const l of extraction.line_items || []) {
    if (!(Number(l.quantity) > 0 || Number(l.line_total) > 0)) continue;
    if (isZeroValue(l)) { notes.push(`"${l.mpn || l.description}": zero-value row ignored`); continue; }
    invLines.push(l);
  }

  // A product surcharge is part of the product price: it is spread over the product lines by value, and the price that
  // is compared with the PO (and billed) is the price including it. A surcharge the PO price already contains lands on
  // the PO price; one the PO does not contain is a price increase and goes to review like any other.
  const lineValue = (l) => (Number.isFinite(numOrNaN(l.line_total)) ? Number(l.line_total) : (Number(l.quantity) || 0) * (Number(l.unit_price) || 0));
  const goods = round2(invLines.reduce((s, l) => s + lineValue(l), 0));
  const surFactor = charges.surcharge > 0 && goods > 0 ? 1 + charges.surcharge / goods : 1;
  const surPct = `${((surFactor - 1) * 100).toFixed(1)}%`;
  if (surFactor !== 1) notes.push(`surcharge ${charges.surcharge.toFixed(2)} (${charges.surcharges.map((c) => c.description).join('; ')}) is part of the product price: +${surPct} on every line`);

  // 1) the price of each invoice line (independent of the PO)
  const priced = invLines.map((inv) => {
    const qty = Number(inv.quantity) || 0;
    let lineTotal = numOrNaN(inv.line_total);
    let rate = numOrNaN(inv.unit_price);
    const pre = [];
    // The line total is what is paid. A printed price that does not multiply up to it is quoted per another measure
    // (per litre, per 100, before a line discount) or was not printed at all: the unit price comes from the line total.
    if (qty > 0 && Number.isFinite(lineTotal) && (!Number.isFinite(rate) || Math.abs(round2(rate * qty) - lineTotal) > Math.max(0.02, 0.005 * qty))) {
      const implied = round4(lineTotal / qty);
      if (Number.isFinite(rate)) pre.push(`printed price ${rate.toFixed(2)} × ${qty} is not the line total ${lineTotal.toFixed(2)} — unit price taken from the line total (${implied.toFixed(2)})`);
      rate = implied;
    }
    if (surFactor !== 1) {
      if (Number.isFinite(lineTotal)) { const t = lineTotal * surFactor; if (qty > 0) rate = round4(t / qty); lineTotal = round2(t); }
      else if (Number.isFinite(rate)) rate = round4(rate * surFactor);
    }
    return { inv, qty, rate, lineTotal, pre, hit: null, via: null, candidates: [], contested: false, noWord: null };
  });

  // 2) by code
  for (const p of priced) {
    const code = normCode(p.inv.mpn);
    if (!code) continue;
    for (const k of keyed) { const key = k.keys.find((x) => x.n === code); if (key) { p.hit = k.line; p.via = key.source; break; } }
    if (!p.hit) { // tolerate a PO code that is a prefix/suffix of the invoice code or vice versa (pack sizes appended)
      for (const k of keyed) { const key = k.keys.find((x) => x.n.length >= 4 && (code.startsWith(x.n) || x.n.startsWith(code))); if (key) { p.hit = k.line; p.via = `${key.source}~`; break; } }
    }
  }

  // 3) by value, for what no code matched — only against open PO lines whose item has no supplier-side code (a line
  //    that has one is matched by it or not at all), only when it is the one line that fits and no other invoice line
  //    could take it, and only when the descriptions share a word.
  const unmatched = priced.filter((p) => !p.hit);
  if (cfg.valueFallback && unmatched.length) {
    const taken = new Set(priced.filter((p) => p.hit).map((p) => p.hit.line_item_id));
    const pool = keyed.filter((k) => !taken.has(k.line.line_item_id) && remainingQty(k.line) > 0 && !k.keys.some((x) => x.source === 'supplier_reference' || x.source === 'mpn'));
    const fits = (p, k) => {
      const poRate = Number(k.line.rate); const available = remainingQty(k.line);
      if (!(p.qty > 0) || !(poRate > 0)) return false;
      if (Number.isFinite(p.rate) && Math.abs(p.rate - poRate) <= cfg.priceAbs + 1e-9 && p.qty <= available + 1e-9) return true;
      return !!packUnits({ qty: p.qty, lineTotal: p.lineTotal, poRate, available, priceAbs: cfg.priceAbs, roundingPerItem: cfg.packRoundingPerItem });
    };
    for (const p of unmatched) p.candidates = pool.filter((k) => fits(p, k)).map((k) => k.line);
    for (const p of unmatched) {
      if (p.candidates.length !== 1) continue;
      const line = p.candidates[0];
      if (unmatched.some((o) => o !== p && o.candidates.includes(line))) { p.contested = true; continue; }
      if (!shareWord(p.inv.description, `${line.name || ''} ${line.description || ''}`)) { p.noWord = line; continue; }
      p.hit = line; p.via = 'value';
    }
  }

  // 4) kit: the supplier invoices as separate parts a kit that the PO orders as one line. The invoice lines that match
  //    nothing else — plus any line already matched to that kit line itself — are billed as the kit when together they
  //    make up what is still open on it (kits = the open quantity, price per kit = their total / kits) within the usual
  //    price rule. Only PO lines named as a kit, at least two parts, and exactly one kit line that fits; otherwise the
  //    lines stay LINE_UNMATCHED and the report says why.
  const kitEntries = [];
  const kitProblems = [];
  const leftovers = priced.filter((p) => !p.hit);
  if (cfg.kitRule && leftovers.length) {
    const partValue = (p) => (Number.isFinite(p.lineTotal) ? p.lineTotal : (Number.isFinite(p.rate) ? p.qty * p.rate : NaN));
    const fitting = []; const tried = [];
    for (const k of keyed) {
      const line = k.line; const open = remainingQty(line); const poRate = Number(line.rate);
      if (!isKitLine(line) || !(open > 0) || !(poRate > 0)) continue;
      // a line matched to the kit line that is priced like the kit IS the kit (invoiced whole): no parts to collect
      const own = priced.filter((p) => p.hit && p.hit.line_item_id === line.line_item_id);
      if (own.some((p) => { const b = priceBand(poRate, cfg); const d = round2(p.rate - poRate); return Number.isFinite(p.rate) && d <= b.up + 1e-9 && -d <= b.down + 1e-9; })) continue;
      const parts = [...leftovers, ...own];
      if (parts.length < 2 || parts.some((p) => !Number.isFinite(partValue(p)))) continue;
      const total = round2(parts.reduce((s, p) => s + partValue(p), 0));
      const rate = round4(total / open);
      const d = round2(rate - poRate); const band = priceBand(poRate, cfg);
      const entry = { line, parts, total, rate, open, poRate, own: own.length };
      if (d <= band.up + 1e-9 && -d <= band.down + 1e-9) fitting.push(entry); else tried.push(entry);
    }
    if (fitting.length === 1) {
      const kit = fitting[0];
      for (const p of kit.parts) { p.kit = kit; p.hit = null; }
      kitEntries.push({ inv: { mpn: null, description: kit.line.name, quantity: kit.open }, qty: kit.open, rate: kit.rate, lineTotal: kit.total, pre: kit.parts.flatMap((p) => p.pre.map((n) => `${p.inv.mpn || p.inv.description}: ${n}`)), hit: kit.line, via: 'kit', parts: kit.parts.map((p) => p.inv.mpn || p.inv.description), candidates: [] });
    } else if (fitting.length > 1) {
      kitProblems.push({ code: 'LINE_UNMATCHED', text: `the ${leftovers.length} invoice lines not on the PO add up to ${round2(leftovers.reduce((s, p) => s + partValue(p), 0)).toFixed(2)}, which fits more than one kit line (${fitting.slice(0, 3).map((f) => f.line.name).join('; ')}) — not billed as a kit` });
    } else if (tried.length === 1 && !tried[0].own) {
      const t = tried[0];
      const pct = `${t.rate > t.poRate ? '+' : ''}${((t.rate - t.poRate) / t.poRate * 100).toFixed(1)}%`;
      kitProblems.push({ code: 'LINE_UNMATCHED', text: `the ${t.parts.length} invoice lines not on the PO (${t.parts.map((p) => p.inv.mpn || p.inv.description).slice(0, 6).join(', ')}) add up to ${t.total.toFixed(2)} = ${t.open} × ${price(t.rate)} vs the kit line "${t.line.name}" at ${t.poRate.toFixed(2)} (${pct}) — not billed as the kit` });
    }
  }

  const matched = []; // { inv, po, qty, rate, poRate, priceDiffPct }
  const valueMatches = []; // lines matched without a code: the report tells finance which code to add to which item
  const byPo = new Map(); // po line_item_id → accumulated qty
  problems.push(...kitProblems);
  for (const p of [...priced.filter((x) => !x.kit), ...kitEntries]) {
    const { inv, hit } = p;
    if (!hit) {
      const what = `"${inv.mpn || inv.description}" (qty ${inv.quantity})`;
      let text;
      if (p.candidates.length > 1 || p.contested) {
        text = `${what} has no code on the PO and its value fits more than one line (${p.candidates.slice(0, 3).map((l) => l.name).join('; ')}) — not matched`;
      } else if (p.noWord) {
        text = `${what} has no code on the PO; "${p.noWord.name}" fits by value but the descriptions share no word — not matched`;
      } else {
        const keyless = keyed.filter((k) => !k.keys.length).map((k) => k.line.name);
        text = `${what} is not on the PO${keyless.length ? ` — PO lines without a ${cfg.supplierRefLabel}/MPN: ${keyless.slice(0, 3).join('; ')}` : ''}`;
      }
      problems.push({ code: 'LINE_UNMATCHED', text });
      continue;
    }
    let { qty, rate } = p;
    const { lineTotal } = p;
    const label = inv.mpn || hit.name;
    for (const n of p.pre) notes.push(`${label}: ${n}`);
    const poRate = Number(hit.rate);
    const prev = byPo.get(hit.line_item_id) || 0;
    const remaining = remainingQty(hit);
    if (p.via === 'kit') {
      notes.push(`${label}: invoiced as ${p.parts.length} separate parts (${p.parts.join(', ')}) totalling ${lineTotal.toFixed(2)} — billed as the kit, ${qty} × ${price(rate)}`);
    }
    if (p.via === 'value') {
      notes.push(`${label}: no ${cfg.supplierRefLabel} / MPN on PO line "${hit.name}" — matched by value (${qty} × ${Number.isFinite(rate) ? rate.toFixed(2) : '?'})${inv.mpn ? `; add ${cfg.supplierRefLabel} ${inv.mpn} to the item` : ''}`);
      valueMatches.push({ code: inv.mpn || null, po_line: hit.line_item_id, item_id: hit.item_id || null, name: hit.name });
    }
    // Pack ↔ each: same code, but the supplier counts single units where the PO line is a pack (or the reverse).
    const pack = p.via === 'kit' ? null : packUnits({ qty, lineTotal, poRate, available: round2(remaining - prev), priceAbs: cfg.priceAbs, roundingPerItem: cfg.packRoundingPerItem });
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
      const pct = `${d > 0 ? '+' : ''}${((rate - poRate) / poRate * 100).toFixed(1)}%`;
      // a pack ↔ each line carries the per-item rounding as its guard (both directions: rounding, not a price change)
      const guard = pack ? Math.max(cfg.priceAbs, pack.rounding) : cfg.priceAbs;
      const { down: tolDown, up: tolUp } = priceBand(poRate, cfg, guard);
      const incl = surFactor !== 1 ? ` incl. the ${surPct} surcharge` : '';
      if (d > tolUp) {
        priceOk = false;
        problems.push({ code: 'PRICE_MISMATCH', text: `${label}: unit price ${price(rate)}${incl} vs PO ${poRate.toFixed(2)} (${pct}; ${cfg.pricePctUp > 0 ? `allowed up to +${cfg.pricePctUp}%` : 'price increases always go to review'})` });
      } else if (-d > tolDown) {
        priceOk = false;
        problems.push({ code: 'PRICE_MISMATCH', text: `${label}: unit price ${price(rate)}${incl} vs PO ${poRate.toFixed(2)} (${pct}; allowed down to -${cfg.pricePctDown}%)` });
      } else if (Math.abs(d) > cfg.priceAbs + 1e-9) {
        priceNote = `${label}: invoiced at ${price(rate)}${incl} vs PO ${poRate.toFixed(2)} (${pct}, billed at the invoice price)`;
      }
    }
    if (priceNote) notes.push(priceNote);
    matched.push({ inv, po: hit, qty, rate: Number.isFinite(rate) ? rate : poRate, poRate, via: p.via, parts: p.parts || null, priceOk, taxPct: Number(hit.tax_percentage) || 0 });
  }
  // An invoice for the carriage alone (the goods were invoiced earlier without it) has no product lines by design.
  const carriageOnly = !invLines.length && invCarriage > 0;
  if (carriageOnly) notes.push('carriage-only invoice: no product lines');
  if (!matched.length && !problems.length && !carriageOnly) problems.push({ code: 'LINE_UNMATCHED', text: 'no product lines were read from the invoice' });

  // ---- carriage: the delivery charges against what is still open on the PO's carriage line(s)
  const openCarriagePo = carriagePo.filter((l) => remainingQty(l) > 0);
  const poCarriage = round2(openCarriagePo.reduce((s, l) => s + (Number(l.rate) || 0) * remainingQty(l), 0));
  const excess = round2(invCarriage - poCarriage);
  const carriage = { invoice: invCarriage, po: poCarriage, rule: vendorRule.rule, tolerance: vendorRule.tolerance, diff: round2(Math.abs(excess)), excess, ok: true, source: vendorRule.source };
  const alreadyBilled = carriagePo.length > 0 && !openCarriagePo.length;
  if (cfg.carriageBelowPoOk && excess <= 0.01) {
    // at or below the PO: accepted under every rule and billed as invoiced
    if (invCarriage === 0 && poCarriage > 0) notes.push(`no carriage on the invoice — ${poCarriage.toFixed(2)} stays open on the PO for a separate carriage invoice`);
    else if (invCarriage > 0 && excess < -0.01) notes.push(`carriage ${invCarriage.toFixed(2)} invoiced vs ${poCarriage.toFixed(2)} on the PO — billed as invoiced, the PO's carriage line is closed`);
  } else {
    if (vendorRule.rule === 'Zero' && carriage.diff > 0.01) carriage.ok = false;
    if (vendorRule.rule === 'Fixed' && carriage.diff > vendorRule.tolerance + 1e-9) carriage.ok = false;
  }
  if (!carriage.ok) problems.push({ code: 'CARRIAGE_MISMATCH', text: `carriage ${invCarriage.toFixed(2)} on the invoice vs ${poCarriage.toFixed(2)} ${alreadyBilled ? 'still open on the PO (its carriage line is already billed)' : 'on the PO'} (rule ${vendorRule.rule}${vendorRule.rule === 'Fixed' ? ` ±${vendorRule.tolerance.toFixed(2)}` : ''})` });
  // The invoice carriage goes on the PO's open carriage line for the whole quantity still open, so the line — and with
  // it the PO — is complete; with no open line it becomes a line of its own on the bill.
  const carriageLine = openCarriagePo[0] || null;
  const carriageQty = carriageLine ? remainingQty(carriageLine) : 0;
  if (carriageLine && openCarriagePo.length > 1 && invCarriage > 0) notes.push(`the PO has ${openCarriagePo.length} open carriage lines — the invoice carriage is billed on "${carriageLine.name}"`);
  const carriageTaxPct = (carriageLine || carriagePo[0]) ? Number((carriageLine || carriagePo[0]).tax_percentage) || 0 : (matched[0] ? matched[0].taxPct : 20);

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
    problems, notes, matched: matched.map((m) => ({ code: m.inv.mpn, po_line: m.po.line_item_id, name: m.po.name, qty: m.qty, rate: m.rate, po_rate: m.poRate, via: m.via, ...(m.parts ? { parts: m.parts } : {}) })),
    quantities, rates, partial, carriageOnly, valueMatches,
    surcharge: { amount: charges.surcharge, rows: charges.surcharges, pct: surFactor !== 1 ? round2((surFactor - 1) * 100) : 0 },
    carriage: { ...carriage, taxPct: carriageTaxPct, poLineId: carriageLine ? carriageLine.line_item_id : null, poLineQty: carriageQty, poLineRate: carriageQty > 0 ? round4(invCarriage / carriageQty) : 0 },
    expected: { net, vat, gross, invoiceGross: invGross, diff: totalsDiff },
  };
}

module.exports = { matchLines, normCode, poLineKeys, isCarriageLine, isKitLine, remainingQty, packUnits, splitCharges, isProductSurcharge, shareWord };
