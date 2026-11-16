'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchLines, normCode, poLineKeys, remainingQty, packUnits, splitCharges, isProductSurcharge, shareWord } = require('../src/pipeline/lines');
const { vendorCarriageRule } = require('../src/pipeline/vendorRules');
const { loadConfig } = require('../src/config');

const cfg = (over = {}) => loadConfig({ PHASE2_ENABLED: 'true', ...over }).matching;
const poLine = (id, ref, qty, rate, extra = {}) => ({ line_item_id: id, item_id: `it-${id}`, name: `Item ${id}`, quantity: qty, quantity_billed: 0, quantity_cancelled: 0, rate, tax_percentage: 20, tax_id: 't20', account_id: 'acc', item_custom_fields: ref ? [{ label: 'Supplier Reference', value: ref }] : [], ...extra });
const carriage = (rate) => ({ line_item_id: 'carr', item_id: 'it-carr', name: 'Carriage', quantity: 1, quantity_billed: 0, rate, tax_percentage: 20, tax_id: 't20', account_id: 'acc', item_custom_fields: [] });
const inv = (lines, carriageAmt = null) => {
  const net = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0) + (carriageAmt || 0);
  return { line_items: lines.map((l) => ({ description: l.d || l.mpn, line_total: l.quantity * l.unit_price, ...l })), totals: { net: r2(net), vat: r2(net * 0.2), carriage: carriageAmt, gross: r2(net * 1.2) } };
};
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const ZERO = { rule: 'Zero', tolerance: 0 }; const FIXED5 = { rule: 'Fixed', tolerance: 5 }; const IGNORE = { rule: 'Ignore', tolerance: 0 };

test('normCode: case, dots, dashes, spaces and slashes are ignored', () => {
  assert.equal(normCode('ZK410-KIT'), normCode('zk410kit')); assert.equal(normCode('7.204.15P'), normCode('7204 15P')); assert.equal(normCode(' MB7260031E1 '), 'MB7260031E1'); assert.equal(normCode(null), '');
});
test('poLineKeys: Supplier Reference first, then item MPN / SKU, then line sku / item_code', () => {
  const k = poLineKeys(poLine('1', 'MB7260031E1', 1, 1, { sku: '512-730118', item_code: 'X1' }), { mpn: 'MB7260031E1', sku: '512-730118' });
  assert.deepEqual(k.map((x) => x.source), ['supplier_reference', 'sku', 'item_code']);
  assert.deepEqual(poLineKeys(poLine('2', null, 1, 1), { mpn: 'M-1', sku: 'S-1' }).map((x) => `${x.source}:${x.raw}`), ['mpn:M-1', 'sku:S-1']);
  assert.deepEqual(poLineKeys(poLine('3', null, 1, 1)), []);
});
test('remainingQty: ordered − billed − cancelled, never negative', () => {
  assert.equal(remainingQty({ quantity: 10, quantity_billed: 6 }), 4); assert.equal(remainingQty({ quantity: 3, quantity_billed: 3 }), 0); assert.equal(remainingQty({ quantity: 5, quantity_billed: 2, quantity_cancelled: 1 }), 2);
});
test('vendorCarriageRule: by label in sandbox and production shapes; default Zero', () => {
  assert.deepEqual(vendorCarriageRule({ custom_fields: [{ label: 'Carriage Rule', value: 'Fixed' }, { label: 'Carriage Tolerance', value: '5.00' }] }), { rule: 'Fixed', tolerance: 5, source: 'vendor' });
  assert.deepEqual(vendorCarriageRule({ cf__sb_20000000001_carriage_rule: 'ignore', cf__sb_20000000001_carriage_tolerance: 2 }), { rule: 'Ignore', tolerance: 2, source: 'vendor' });
  assert.deepEqual(vendorCarriageRule({ custom_fields: [] }), { rule: 'Zero', tolerance: 0, source: 'default' });
  assert.equal(vendorCarriageRule({ custom_fields: [{ label: 'Carriage Rule', value: 'Whatever' }] }).rule, 'Zero');
});

test('exact: every line matched by Supplier Reference, carriage equal under Zero → ok, full quantities, expected = invoice', () => {
  const po = { line_items: [poLine('a', 'RX-4471', 4, 22.5), poLine('b', 'RX-4402', 6, 11.2), carriage(10)] };
  const r = matchLines({ extraction: inv([{ mpn: 'RX-4471', quantity: 4, unit_price: 22.5 }, { mpn: 'RX-4402', quantity: 6, unit_price: 11.2 }], 10), po, vendorRule: ZERO, config: cfg() });
  assert.equal(r.ok, true, JSON.stringify(r.problems)); assert.deepEqual(r.quantities, { a: 4, b: 6 }); assert.equal(r.partial, false);
  assert.equal(r.carriage.ok, true); assert.equal(r.carriage.poLineId, 'carr'); assert.equal(r.expected.gross, r2((90 + 67.2 + 10) * 1.2)); assert.equal(r.expected.diff, 0);
});
test('partial delivery: 6 of 10 → ok and partial; the closing 4 after 6 billed → ok; 5 against 3 ordered → QTY_EXCEEDS', () => {
  const po = { line_items: [poLine('p', 'CP-PR5', 10, 34), poLine('e', 'CP-EM10M', 6, 48.75)] };
  const a = matchLines({ extraction: inv([{ mpn: 'CP-PR5', quantity: 6, unit_price: 34 }]), po, vendorRule: ZERO, config: cfg() });
  assert.equal(a.ok, true); assert.equal(a.partial, true); assert.deepEqual(a.quantities, { p: 6 });
  const po2 = { line_items: [poLine('p', 'CP-PR5', 10, 34, { quantity_billed: 6 }), poLine('e', 'CP-EM10M', 6, 48.75)] };
  const b = matchLines({ extraction: inv([{ mpn: 'CP-PR5', quantity: 4, unit_price: 34 }, { mpn: 'CP-EM10M', quantity: 6, unit_price: 48.75 }]), po: po2, vendorRule: ZERO, config: cfg() });
  assert.equal(b.ok, true); assert.equal(b.partial, false);
  const c = matchLines({ extraction: inv([{ mpn: 'CP-EM10M', quantity: 5, unit_price: 48.75 }]), po: { line_items: [poLine('e', 'CP-EM10M', 3, 48.75)] }, vendorRule: ZERO, config: cfg() });
  assert.equal(c.ok, false); assert.equal(c.reason.code, 'QTY_EXCEEDS'); assert.match(c.reason.text, /invoiced 5 but only 3 remaining/);
});
test('prices (client rule 6 Nov 2026): up to 5% below the PO → billed at the invoice price with a note; further below → PRICE_MISMATCH; any increase → PRICE_MISMATCH; penny rounding ignored', () => {
  const po = { line_items: [poLine('a', 'MB7260031E1', 6, 29.16)] };
  const ok = matchLines({ extraction: inv([{ mpn: 'MB7260031E1', quantity: 6, unit_price: 28.31 }]), po, vendorRule: ZERO, config: cfg() }); // −2.9%
  assert.equal(ok.ok, true); assert.equal(ok.rates.a, 28.31); assert.match(ok.notes[0], /-2\.9%, billed at the invoice price/);
  const edge = matchLines({ extraction: inv([{ mpn: 'MB7260031E1', quantity: 6, unit_price: 27.71 }]), po, vendorRule: ZERO, config: cfg() }); // −4.97%
  assert.equal(edge.ok, true); assert.equal(edge.rates.a, 27.71);
  const low = matchLines({ extraction: inv([{ mpn: 'MB7260031E1', quantity: 6, unit_price: 27.5 }]), po, vendorRule: ZERO, config: cfg() }); // −5.7%
  assert.equal(low.ok, false); assert.equal(low.reason.code, 'PRICE_MISMATCH'); assert.match(low.reason.text, /-5\.7%; allowed down to -5%/);
  const up = matchLines({ extraction: inv([{ mpn: 'MB7260031E1', quantity: 6, unit_price: 29.5 }]), po, vendorRule: ZERO, config: cfg() }); // +1.2%
  assert.equal(up.ok, false); assert.equal(up.reason.code, 'PRICE_MISMATCH'); assert.match(up.reason.text, /\+1\.2%; price increases always go to review/);
  const penny = matchLines({ extraction: inv([{ mpn: 'MB7260031E1', quantity: 6, unit_price: 29.17 }]), po, vendorRule: ZERO, config: cfg() }); // +1p rounding
  assert.equal(penny.ok, true); assert.equal(penny.rates.a, 29.17); assert.equal(penny.notes.length, 0);
  const exact = matchLines({ extraction: inv([{ mpn: 'MB7260031E1', quantity: 6, unit_price: 29.16 }]), po, vendorRule: ZERO, config: cfg() });
  assert.equal(exact.ok, true); assert.equal(exact.notes.length, 0);
  const upAllowed = matchLines({ extraction: inv([{ mpn: 'MB7260031E1', quantity: 6, unit_price: 29.5 }]), po, vendorRule: ZERO, config: cfg({ LINE_PRICE_TOLERANCE_UP_PCT: '2' }) }); // +1.2% ≤ 2%
  assert.equal(upAllowed.ok, true); assert.equal(upAllowed.rates.a, 29.5); assert.match(upAllowed.notes[0], /\+1\.2%, billed at the invoice price/);
  const tight = matchLines({ extraction: inv([{ mpn: 'MB7260031E1', quantity: 6, unit_price: 28.31 }]), po, vendorRule: ZERO, config: cfg({ LINE_PRICE_TOLERANCE_PCT: '1' }) }); // −2.9% > 1%
  assert.equal(tight.reason.code, 'PRICE_MISMATCH');
});
test('carriage per vendor rule: Zero rejects any variance, Fixed ±tolerance, Ignore never; carriage billed at the invoice amount', () => {
  const po = { line_items: [poLine('a', 'RX-4402', 12, 11.2), carriage(10)] };
  const lines = [{ mpn: 'RX-4402', quantity: 12, unit_price: 11.2 }];
  const z = matchLines({ extraction: inv(lines, 12.5), po, vendorRule: ZERO, config: cfg() });
  assert.equal(z.ok, false); assert.equal(z.reason.code, 'CARRIAGE_MISMATCH'); assert.match(z.reason.text, /12\.50 .* 10\.00/);
  const f = matchLines({ extraction: inv(lines, 12.5), po, vendorRule: FIXED5, config: cfg() });
  assert.equal(f.ok, true); assert.equal(f.carriage.diff, 2.5); assert.equal(f.expected.gross, r2((134.4 + 12.5) * 1.2));
  const f2 = matchLines({ extraction: inv(lines, 16), po, vendorRule: FIXED5, config: cfg() });
  assert.equal(f2.reason.code, 'CARRIAGE_MISMATCH');
  const i = matchLines({ extraction: inv(lines, 16), po, vendorRule: IGNORE, config: cfg() });
  assert.equal(i.ok, true);
  const noCarriageOnPo = matchLines({ extraction: inv(lines, 7.5), po: { line_items: [poLine('a', 'RX-4402', 12, 11.2)] }, vendorRule: IGNORE, config: cfg() });
  assert.equal(noCarriageOnPo.ok, true); assert.equal(noCarriageOnPo.carriage.poLineId, null); assert.equal(noCarriageOnPo.carriage.po, 0);
});
test('real shape: 15 of 16 lines at −3% plus an order surcharge on a PO without carriage → Zero rejects the surcharge, Ignore bills it partially at invoice prices', () => {
  const codes = ['MB7260031E1', '31408.2', 'CT0220015N1', 'CT0220015C1', '7.204.15P', '30.RD.1', '4471.0.75', '16.5', '2630', '30.XL.1', '512.TRM.15P', '640.5', '24.WHT.1K', 'PR6100442A1', 'ZK8101007A1', 'ZK410KIT'];
  const poRates = [31.40, 42.75, 152.60, 48.20, 91.15, 84.30, 12.48, 53.90, 9.76, 33.25, 78.40, 64.85, 4.12, 69.50, 41.30, 118.90];
  const qtys = [5, 4, 3, 8, 2, 1, 6, 2, 4, 10, 2, 3, 6, 2, 2, 1];
  const po = { line_items: codes.map((c, i) => poLine(`l${i}`, c, qtys[i], poRates[i])) };
  const invLines = codes.map((c, i) => ({ mpn: i === 15 ? 'ZK410-KIT' : c, quantity: qtys[i], unit_price: r2(poRates[i] * 0.97) })).filter((_, i) => i !== 10); // line 11 back-ordered
  const zero = matchLines({ extraction: inv(invLines, 71.25), po, vendorRule: ZERO, config: cfg() });
  assert.equal(zero.ok, false); assert.equal(zero.reason.code, 'CARRIAGE_MISMATCH');
  const ign = matchLines({ extraction: inv(invLines, 71.25), po, vendorRule: IGNORE, config: cfg() });
  assert.equal(ign.ok, true, JSON.stringify(ign.problems)); assert.equal(ign.partial, true); assert.equal(Object.keys(ign.quantities).length, 15); assert.equal(ign.quantities.l10, undefined);
  assert.equal(ign.matched.find((m) => m.code === 'ZK410-KIT').po_line, 'l15', 'ZK410-KIT matched ZK410KIT');
  assert.equal(ign.carriage.poLineId, null); assert.equal(ign.expected.diff, 0);
});
test('unmatched line, keyless PO lines, MPN via item fallback, fallback to totals when no PO line has a code', () => {
  const po = { line_items: [poLine('a', 'AB-1', 1, 10), poLine('b', null, 1, 20)] };
  const u = matchLines({ extraction: inv([{ mpn: 'AB-1', quantity: 1, unit_price: 10 }, { mpn: 'XX-9', quantity: 1, unit_price: 20 }]), po, vendorRule: IGNORE, config: cfg() });
  assert.equal(u.ok, false); assert.equal(u.reason.code, 'LINE_UNMATCHED'); assert.match(u.reason.text, /XX-9.*"Item b" fits by value but the descriptions share no word/);
  const u2 = matchLines({ extraction: inv([{ mpn: 'AB-1', quantity: 1, unit_price: 10 }, { mpn: 'XX-9', quantity: 1, unit_price: 21 }]), po, vendorRule: IGNORE, config: cfg() }); // nothing fits by value either
  assert.equal(u2.reason.code, 'LINE_UNMATCHED'); assert.match(u2.reason.text, /XX-9.*PO lines without a Supplier Reference\/MPN: Item b/);
  const viaItem = matchLines({ extraction: inv([{ mpn: 'AB-1', quantity: 1, unit_price: 10 }, { mpn: 'XX-9', quantity: 1, unit_price: 20 }]), po, items: new Map([['it-b', { mpn: 'XX-9' }]]), vendorRule: IGNORE, config: cfg() });
  assert.equal(viaItem.ok, true); assert.equal(viaItem.matched[1].via, 'mpn');
  const fb = matchLines({ extraction: inv([{ mpn: 'Q', quantity: 1, unit_price: 5 }]), po: { line_items: [poLine('x', null, 1, 5)] }, vendorRule: ZERO, config: cfg() });
  assert.equal(fb.fallback, 'totals'); assert.equal(fb.reason.code, 'NO_MPN');
});
test('totals guard: lines match but the invoice total does not add up (unread line) → TOTAL_MISMATCH', () => {
  const po = { line_items: [poLine('a', 'AB-1', 2, 10)] };
  const e = inv([{ mpn: 'AB-1', quantity: 2, unit_price: 10 }]); e.totals.gross = 60; // invoice says 60, lines say 24
  const r = matchLines({ extraction: e, po, vendorRule: ZERO, config: cfg() });
  assert.equal(r.ok, false); assert.equal(r.reason.code, 'TOTAL_MISMATCH'); assert.match(r.reason.text, /24\.00 .* 60\.00/);
});

// ---- findings from the second set of real documents (Nov 2026)
test('poLineKeys: the Books MPN field arrives as part_number; an object item_code is not a key', () => {
  assert.deepEqual(poLineKeys(poLine('1', null, 1, 1, { sku: 'S-1', item_code: {} }), { part_number: 'M-77', sku: 'S-1' }).map((x) => `${x.source}:${x.raw}`), ['mpn:M-77', 'sku:S-1']);
  const r = matchLines({ extraction: inv([{ mpn: 'M-77', quantity: 2, unit_price: 5 }]), po: { line_items: [poLine('a', null, 2, 5)] }, items: new Map([['it-a', { part_number: 'M-77' }]]), vendorRule: ZERO, config: cfg() });
  assert.equal(r.ok, true, JSON.stringify(r.problems)); assert.equal(r.matched[0].via, 'mpn');
});
test('zero-value row (courier name at 0.00) is ignored and noted, not LINE_UNMATCHED', () => {
  const e = inv([{ mpn: 'AB-1', quantity: 6, unit_price: 5.5 }, { mpn: 'S1', d: 'COURIER PLEASE', quantity: 1, unit_price: 0 }]);
  const r = matchLines({ extraction: e, po: { line_items: [poLine('a', 'AB-1', 6, 5.5)] }, vendorRule: ZERO, config: cfg() });
  assert.equal(r.ok, true, JSON.stringify(r.problems)); assert.match(r.notes.join(' '), /S1.*zero-value row ignored/);
});
test('unit price quoted per another measure, or missing: priced from the line total', () => {
  const po = { line_items: [poLine('a', 'QZ-20L', 1, 302.2)] };
  const perLitre = { line_items: [{ mpn: 'QZ-20L', description: '20 L pack', quantity: 1, unit_price: 15.11, line_total: 302.2 }], totals: { net: 302.2, vat: 60.44, carriage: null, gross: 362.64 } };
  const a = matchLines({ extraction: perLitre, po, vendorRule: ZERO, config: cfg() });
  assert.equal(a.ok, true, JSON.stringify(a.problems)); assert.equal(a.rates.a, 302.2); assert.match(a.notes.join(' '), /unit price taken from the line total/);
  const noPrice = { line_items: [{ mpn: 'QZ-20L', description: 'x', quantity: 1, unit_price: null, line_total: 302.2 }], totals: perLitre.totals };
  const b = matchLines({ extraction: noPrice, po, vendorRule: ZERO, config: cfg() });
  assert.equal(b.ok, true, JSON.stringify(b.problems)); assert.equal(b.rates.a, 302.2);
  // a line discount: 5 × 10.00 less 10% = 45.00 → the price paid is 9.00, 10% under the PO → review
  const disc = { line_items: [{ mpn: 'AB-1', description: 'x', quantity: 5, unit_price: 10, line_total: 45 }], totals: { net: 45, vat: 9, carriage: null, gross: 54 } };
  const c = matchLines({ extraction: disc, po: { line_items: [poLine('a', 'AB-1', 5, 10)] }, vendorRule: ZERO, config: cfg() });
  assert.equal(c.ok, false); assert.equal(c.reason.code, 'PRICE_MISMATCH'); assert.match(c.reason.text, /9\.00 vs PO 10\.00/);
});
test('pack ↔ each: same code, same money, whole pack size, units available → billed in PO units; otherwise the plain reading stands', () => {
  // 6 EACH × 184.71 against 1 "box of 6" × 1108.26
  const box = matchLines({ extraction: inv([{ mpn: '4481001', quantity: 6, unit_price: 184.71 }], 80), po: { line_items: [poLine('a', '4481001', 1, 1108.26), carriage(20)] }, vendorRule: IGNORE, config: cfg() });
  assert.equal(box.ok, true, JSON.stringify(box.problems)); assert.deepEqual(box.quantities, { a: 1 }); assert.equal(box.rates.a, 1108.26); assert.equal(box.partial, false);
  assert.equal(box.expected.gross, r2((1108.26 + 80) * 1.2)); assert.match(box.notes.join(' '), /billed as 1 PO unit/);
  // the reverse: 1 box × 120.00 against 12 × 10.00
  const each = matchLines({ extraction: inv([{ mpn: 'AB-1', quantity: 1, unit_price: 120 }]), po: { line_items: [poLine('a', 'AB-1', 12, 10)] }, vendorRule: ZERO, config: cfg() });
  assert.equal(each.ok, true, JSON.stringify(each.problems)); assert.deepEqual(each.quantities, { a: 12 }); assert.equal(each.rates.a, 10);
  // same money but the PO does not have the units (2 ordered, invoice 2 × double price) → a price increase, as before
  const dbl = matchLines({ extraction: inv([{ mpn: 'AB-1', quantity: 2, unit_price: 50 }]), po: { line_items: [poLine('a', 'AB-1', 2, 25)] }, vendorRule: ZERO, config: cfg() });
  assert.equal(dbl.ok, false); assert.equal(dbl.reason.code, 'PRICE_MISMATCH');
  // not a whole pack size / not the same money → no conversion
  assert.equal(packUnits({ qty: 5, lineTotal: 30, poRate: 10, available: 10 }), null); // 3 units from 5: factor 1.67
  assert.equal(packUnits({ qty: 6, lineTotal: 1100, poRate: 1108.26, available: 1 }), null); // 8.26 short of one pack
  assert.equal(packUnits({ qty: 6, lineTotal: 1108.26, poRate: 184.71, available: 6 }), null); // same units: nothing to convert
  assert.deepEqual(packUnits({ qty: 6, lineTotal: 1108.26, poRate: 1108.26, available: 1 }), { units: 1, rate: 1108.26, factor: 6 });
});

// ---- client rules of 16 Nov 2026: carriage at or below the PO, product surcharges, items without a supplier code
const withCharges = (e, charges) => { const sum = r2(charges.reduce((t, c) => t + c.amount, 0)); const net = r2(e.line_items.reduce((t, l) => t + l.line_total, 0) + sum); return { ...e, charges, totals: { net, vat: r2(net * 0.2), carriage: sum, gross: r2(net * 1.2) } }; };

test('carriage at or below the PO passes under every rule and is billed as invoiced; above it the vendor rule decides; CARRIAGE_BELOW_PO_OK=false restores the two-way check', () => {
  const po = { line_items: [poLine('a', 'RX-4402', 12, 11.2), carriage(12)] };
  const lines = [{ mpn: 'RX-4402', quantity: 12, unit_price: 11.2 }];
  const lower = matchLines({ extraction: inv(lines, 4.99), po, vendorRule: ZERO, config: cfg() });
  assert.equal(lower.ok, true, JSON.stringify(lower.problems)); assert.deepEqual([lower.carriage.poLineId, lower.carriage.poLineQty, lower.carriage.poLineRate], ['carr', 1, 4.99]);
  assert.equal(lower.expected.gross, r2((134.4 + 4.99) * 1.2)); assert.match(lower.notes.join(' '), /carriage 4\.99 invoiced vs 12\.00 on the PO — billed as invoiced, the PO's carriage line is closed/);
  const none = matchLines({ extraction: inv(lines), po, vendorRule: ZERO, config: cfg() });
  assert.equal(none.ok, true, JSON.stringify(none.problems)); assert.equal(none.carriage.invoice, 0); assert.equal(none.expected.gross, r2(134.4 * 1.2));
  assert.match(none.notes.join(' '), /no carriage on the invoice — 12\.00 stays open on the PO for a separate carriage invoice/);
  const equal = matchLines({ extraction: inv(lines, 12), po, vendorRule: ZERO, config: cfg() });
  assert.equal(equal.ok, true); assert.equal(equal.notes.length, 0);
  assert.equal(matchLines({ extraction: inv(lines, 12.5), po, vendorRule: ZERO, config: cfg() }).reason.code, 'CARRIAGE_MISMATCH');
  assert.equal(matchLines({ extraction: inv(lines, 16), po, vendorRule: FIXED5, config: cfg() }).ok, true); // 4.00 above ≤ 5.00
  assert.equal(matchLines({ extraction: inv(lines, 18), po, vendorRule: FIXED5, config: cfg() }).reason.code, 'CARRIAGE_MISMATCH'); // 6.00 above
  assert.equal(matchLines({ extraction: inv(lines, 2), po, vendorRule: FIXED5, config: cfg() }).ok, true, 'Fixed: far below the PO is still below the PO');
  const strict = matchLines({ extraction: inv(lines, 4.99), po, vendorRule: ZERO, config: cfg({ CARRIAGE_BELOW_PO_OK: 'false' }) });
  assert.equal(strict.reason.code, 'CARRIAGE_MISMATCH');
  assert.equal(matchLines({ extraction: inv(lines, 2), po, vendorRule: FIXED5, config: cfg({ CARRIAGE_BELOW_PO_OK: 'false' }) }).reason.code, 'CARRIAGE_MISMATCH');
});
test('carriage-only invoice bills the open carriage line of the PO; a carriage line that is already billed leaves nothing open for a second shipment', () => {
  const po = { line_items: [poLine('a', 'RX-4402', 12, 11.2, { quantity_billed: 12 }), carriage(11.5)] };
  const only = matchLines({ extraction: inv([], 11.5), po, vendorRule: ZERO, config: cfg() });
  assert.equal(only.ok, true, JSON.stringify(only.problems)); assert.equal(only.carriageOnly, true); assert.deepEqual(only.quantities, {}); assert.equal(only.partial, false);
  assert.deepEqual([only.carriage.poLineId, only.carriage.poLineQty, only.carriage.poLineRate], ['carr', 1, 11.5]); assert.equal(only.expected.gross, 13.8); assert.equal(only.expected.diff, 0);
  const empty = matchLines({ extraction: inv([]), po, vendorRule: ZERO, config: cfg() }); // neither lines nor carriage: nothing was read
  assert.equal(empty.reason.code, 'LINE_UNMATCHED'); assert.match(empty.reason.text, /no product lines were read/);
  // second part-shipment that charges carriage again: the PO's carriage line went with the first
  const po2 = { line_items: [poLine('a', 'RX-4402', 10, 11.2, { quantity_billed: 6 }), { ...carriage(10), quantity_billed: 1 }] };
  const second = [{ mpn: 'RX-4402', quantity: 4, unit_price: 11.2 }];
  const again = matchLines({ extraction: inv(second, 10), po: po2, vendorRule: ZERO, config: cfg() });
  assert.equal(again.reason.code, 'CARRIAGE_MISMATCH'); assert.match(again.reason.text, /10\.00 on the invoice vs 0\.00 still open on the PO \(its carriage line is already billed\)/);
  const ign = matchLines({ extraction: inv(second, 10), po: po2, vendorRule: IGNORE, config: cfg() });
  assert.equal(ign.ok, true); assert.equal(ign.carriage.poLineId, null, 'no open PO carriage line → the bill gets its own carriage line');
  assert.equal(matchLines({ extraction: inv(second), po: po2, vendorRule: ZERO, config: cfg() }).ok, true, 'no carriage on the second invoice is fine');
});
test('charges: a surcharge that does not name the delivery is a product surcharge; everything else is carriage', () => {
  for (const d of ['SUR02 PRODUCT GROUP 5% SURCHARGE', 'SUR02 PRODUCT SURCHARGE 5%', 'Order Surcharge', 'Raw material levy']) assert.equal(isProductSurcharge(d), true, d);
  for (const d of ['Carriage Net', 'del - Custom Delivery', 'SERVFC FREIGHT CHARGE', 'CARRIAGE PRE 10AM DELIVERY', 'Fuel surcharge', 'Delivery surcharge', 'Pallet surcharge', 'P&P', 'Other charges', '']) assert.equal(isProductSurcharge(d), false, d);
  assert.deepEqual(splitCharges({ totals: { carriage: 16.6 }, charges: [{ description: 'SUR02 PRODUCT GROUP 5% SURCHARGE', amount: 1.65 }, { description: 'Carriage Net', amount: 14.95 }] }), { carriage: 14.95, surcharge: 1.65, surcharges: [{ description: 'SUR02 PRODUCT GROUP 5% SURCHARGE', amount: 1.65 }] });
  assert.deepEqual(splitCharges({ totals: { carriage: 69.89 } }), { carriage: 69.89, surcharge: 0, surcharges: [] }, 'one carriage figure without a list stays carriage');
  assert.equal(splitCharges({ totals: { carriage: 1.65 }, charges: [{ description: 'Order Surcharge', amount: 1.65 }] }, { surchargeInPrice: false }).carriage, 1.65);
});
test('product surcharge is part of the product price: one the PO price contains lands on the PO price; one it does not contain is a price increase', () => {
  // the PO price (19.80) contains the 5%: the supplier prints 18.86 and a 5% surcharge row
  const po = { line_items: [poLine('a', 'BS-MT48', 6, 19.8)] };
  const e = withCharges(inv([{ mpn: 'BS-MT48', quantity: 6, unit_price: 18.86 }]), [{ description: 'SUR02 PRODUCT SURCHARGE 5%', amount: 5.66 }]);
  const inPrice = matchLines({ extraction: e, po, vendorRule: ZERO, config: cfg() });
  assert.equal(inPrice.ok, true, JSON.stringify(inPrice.problems)); assert.equal(inPrice.rates.a, 19.8033); assert.equal(inPrice.carriage.invoice, 0); assert.equal(inPrice.surcharge.amount, 5.66);
  assert.equal(inPrice.expected.gross, e.totals.gross); assert.equal(inPrice.expected.diff, 0); assert.match(inPrice.notes.join(' '), /surcharge 5\.66 \(SUR02 PRODUCT SURCHARGE 5%\) is part of the product price: \+5\.0% on every line/);
  // the PO price does not contain it: 19.80 + 5% against 19.80 → review; the carriage (equal to the PO) is not the problem
  const po2 = { line_items: [poLine('a', 'BS-MT48', 6, 19.8), carriage(14.95)] };
  const e2 = withCharges(inv([{ mpn: 'BS-MT48', quantity: 6, unit_price: 19.8 }]), [{ description: 'Product Group 5% Surcharge', amount: 5.94 }, { description: 'Carriage Net', amount: 14.95 }]);
  const extra = matchLines({ extraction: e2, po: po2, vendorRule: ZERO, config: cfg() });
  assert.equal(extra.ok, false); assert.equal(extra.reason.code, 'PRICE_MISMATCH'); assert.equal(extra.problems.length, 1); assert.equal(extra.carriage.ok, true); assert.equal(extra.carriage.invoice, 14.95);
  assert.match(extra.reason.text, /unit price 20\.79 incl\. the 5\.0% surcharge vs PO 19\.80 \(\+5\.0%; price increases always go to review\)/);
  // spread by value over several lines; a delivery surcharge stays carriage
  const po3 = { line_items: [poLine('a', 'A-1', 2, 10.3), poLine('b', 'B-1', 1, 20.6)] };
  const e3 = withCharges(inv([{ mpn: 'A-1', quantity: 2, unit_price: 10 }, { mpn: 'B-1', quantity: 1, unit_price: 20 }]), [{ description: 'Order Surcharge', amount: 1.2 }]);
  const spread = matchLines({ extraction: e3, po: po3, vendorRule: ZERO, config: cfg() });
  assert.equal(spread.ok, true, JSON.stringify(spread.problems)); assert.deepEqual(spread.rates, { a: 10.3, b: 20.6 }); assert.equal(spread.expected.diff, 0);
  const fuel = matchLines({ extraction: withCharges(inv([{ mpn: 'BS-MT48', quantity: 6, unit_price: 19.8 }]), [{ description: 'Fuel surcharge', amount: 3 }]), po, vendorRule: ZERO, config: cfg() });
  assert.equal(fuel.reason.code, 'CARRIAGE_MISMATCH'); assert.equal(fuel.surcharge.amount, 0);
  // SURCHARGE_IN_PRICE=false: the surcharge counts as carriage again
  const old = matchLines({ extraction: e, po, vendorRule: IGNORE, config: cfg({ SURCHARGE_IN_PRICE: 'false' }) });
  assert.equal(old.ok, true); assert.equal(old.carriage.invoice, 5.66); assert.equal(old.rates.a, 18.86);
});
test('value fallback: an item without a supplier code is matched by value only when one open line fits, nothing else could take it and the descriptions share a word', () => {
  const plain = (id, name, qty, rate, extra = {}) => poLine(id, null, qty, rate, { name, sku: `INT-${id}`, ...extra }); // internal SKU only
  const po = { line_items: [poLine('a', 'AB-1', 2, 10), plain('n', 'Anti-Slip GRP Stair Nosing: White, Profile - 55mm x 55mm', 22, 5.8), carriage(15)] };
  const line = (over = {}) => ({ mpn: 'SN1200WH', d: 'Anti-Slip GRP Stair Nosing 55mm x 55mm x 1.2m White', quantity: 22, unit_price: 5.8, ...over });
  const r = matchLines({ extraction: inv([{ mpn: 'AB-1', quantity: 2, unit_price: 10 }, line()], 15), po, vendorRule: ZERO, config: cfg() });
  assert.equal(r.ok, true, JSON.stringify(r.problems)); assert.deepEqual(r.quantities, { a: 2, n: 22 }); assert.equal(r.matched[1].via, 'value'); assert.equal(r.partial, false);
  assert.deepEqual(r.valueMatches, [{ code: 'SN1200WH', po_line: 'n', item_id: 'it-n', name: 'Anti-Slip GRP Stair Nosing: White, Profile - 55mm x 55mm' }]);
  assert.match(r.notes.join(' '), /SN1200WH: no Supplier Reference \/ MPN on PO line "Anti-Slip GRP Stair Nosing.*" — matched by value \(22 × 5\.80\); add Supplier Reference SN1200WH to the item/);
  const un = (extraction, p = po, over = {}) => matchLines({ extraction, po: p, vendorRule: ZERO, config: cfg(over) });
  assert.match(un(inv([line({ unit_price: 5.5 })], 15)).reason.text, /SN1200WH.*is not on the PO/, 'a different price is not the same value');
  assert.match(un(inv([line({ quantity: 30 })], 15)).reason.text, /SN1200WH.*is not on the PO/, 'more than is open on the line');
  assert.match(un(inv([line({ d: 'Drain cover' })], 15)).reason.text, /fits by value but the descriptions share no word/);
  assert.equal(un(inv([line()], 15), po, { LINE_VALUE_FALLBACK: 'false' }).reason.code, 'LINE_UNMATCHED');
  // a PO line whose item HAS a supplier code is matched by that code or not at all
  const coded = { line_items: [poLine('n', 'OTHER-CODE', 22, 5.8, { name: 'Anti-Slip GRP Stair Nosing: White' })] };
  assert.equal(un(inv([line()]), coded).reason.code, 'LINE_UNMATCHED');
  const viaMpn = matchLines({ extraction: inv([line()]), po: { line_items: [plain('n', 'Anti-Slip GRP Stair Nosing: White', 22, 5.8)] }, items: new Map([['it-n', { part_number: 'OTHER-CODE', sku: 'INT-n' }]]), vendorRule: ZERO, config: cfg() });
  assert.equal(viaMpn.reason.code, 'LINE_UNMATCHED', 'an item MPN that differs also blocks the value match');
  // the same product in two colours at the same price: two lines fit → review
  const twins = { line_items: [plain('w', 'Stair Nosing White', 2, 31.4), plain('b', 'Stair Nosing Black', 2, 31.4)] };
  const amb = un(inv([{ mpn: 'SN-W', d: 'Stair Nosing White', quantity: 2, unit_price: 31.4 }, { mpn: 'SN-B', d: 'Stair Nosing Black', quantity: 2, unit_price: 31.4 }]), twins);
  assert.equal(amb.ok, false); assert.equal(amb.problems.length, 2); assert.match(amb.reason.text, /has no code on the PO and its value fits more than one line \(Stair Nosing White; Stair Nosing Black\)/);
  // two invoice lines that could both take the one open line → neither
  const one = { line_items: [plain('w', 'Stair Nosing White', 4, 31.4)] };
  const contested = un(inv([{ mpn: 'SN-W', d: 'Stair Nosing White', quantity: 2, unit_price: 31.4 }, { mpn: 'SN-X', d: 'Stair Nosing White', quantity: 2, unit_price: 31.4 }]), one);
  assert.equal(contested.problems.length, 2); assert.equal(contested.reason.code, 'LINE_UNMATCHED');
  // pack ↔ each also applies to a value match
  const packed = un(inv([{ mpn: 'SN-W', d: 'Stair Nosing White', quantity: 6, unit_price: 5 }]), { line_items: [plain('w', 'Stair Nosing White (box of 6)', 1, 30)] });
  assert.equal(packed.ok, true, JSON.stringify(packed.problems)); assert.deepEqual(packed.quantities, { w: 1 });
  assert.equal(shareWord('GRP Nosing 55mm', 'Stair nosing, 55mm'), true); assert.equal(shareWord('55mm x 55mm 1200', 'Profile - 55mm x 55mm'), false, 'sizes alone do not confirm a match');
});
