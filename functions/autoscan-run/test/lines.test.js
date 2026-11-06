'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchLines, normCode, poLineKeys, remainingQty } = require('../src/pipeline/lines');
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
  assert.equal(u.ok, false); assert.equal(u.reason.code, 'LINE_UNMATCHED'); assert.match(u.reason.text, /XX-9.*PO lines without a Supplier Reference\/MPN: Item b/);
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
