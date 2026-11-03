'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { matchTotals, sumBilled } = require('../src/pipeline/match');
const { candidatesFor } = require('../src/pipeline/resolvePo');
const { detectMime, isSupported, estimatePageCount } = require('../src/util/mime');
const { parseAmount } = require('../src/util/money');
const { normaliseExtraction } = require('../src/claude/schema');
const { createRateLimiter, mapWithConcurrency } = require('../src/util/limiter');
const { buildBillPayload, paymentTermsFromPo } = require('../src/pipeline/bill');
const { loadConfig } = require('../src/config');

test('matchTotals: within tolerance on PO total', () => {
  const m = matchTotals({ invoiceGross: 120.01, poTotal: 120.0, tolerance: 0.02 });
  assert.equal(m.ok, true); assert.equal(m.basis, 'po_total'); assert.equal(m.difference, 0.01);
});
test('matchTotals: outside tolerance', () => {
  const m = matchTotals({ invoiceGross: 121.0, poTotal: 120.0, tolerance: 0.02 });
  assert.equal(m.ok, false); assert.equal(m.difference, 1);
});
test('matchTotals: closing invoice of a partially billed PO matches on remaining', () => {
  const m = matchTotals({ invoiceGross: 40.0, poTotal: 100.0, billedTotal: 60.0, tolerance: 0.02 });
  assert.equal(m.ok, true); assert.equal(m.basis, 'remaining'); assert.equal(m.remaining, 40);
});
test('matchTotals: remaining basis disabled by config', () => {
  const m = matchTotals({ invoiceGross: 40.0, poTotal: 100.0, billedTotal: 60.0, tolerance: 0.02, compareAgainstRemaining: false });
  assert.equal(m.ok, false);
});
test('matchTotals: non-numeric input is a mismatch, not a crash', () => {
  const m = matchTotals({ invoiceGross: null, poTotal: 10 });
  assert.equal(m.ok, false);
});
test('sumBilled', () => { assert.equal(sumBilled([{ total: 10.5 }, { total: '20.25' }, {}]), 30.75); });

test('candidatesFor: legacy IPO/ reference', () => {
  const c = candidatesFor('IPO/316037');
  assert.deepEqual(c.slice(0, 3), ['IPO/316037', 'IPO 316037', 'IPO-316037']);
  assert.ok(c.includes('PO-316037'));
  assert.ok(c.includes('316037'));
});
test('candidatesFor: embedded text with suffix yields the legacy token first', () => {
  const c = candidatesFor('Order No. IPO 317792-Harlow', { legacyPrefixes: ['IPO/', 'IPO ', 'IPO-'] });
  assert.deepEqual(c.slice(0, 4), ['Order No. IPO 317792-Harlow', 'IPO/317792', 'IPO 317792', 'IPO-317792']);
  assert.ok(c.includes('PO-317792'));
  assert.ok(c.includes('317792'));
  assert.ok(candidatesFor('Your order: PO 12').includes('PO-00012'));
});
test('candidatesFor: Zoho format and short numbers', () => {
  assert.ok(candidatesFor('PO-00235').includes('PO-00235'));
  assert.ok(candidatesFor('PO-00235').includes('00235'));
  assert.ok(candidatesFor('235').includes('PO-00235'));
  assert.deepEqual(candidatesFor(''), []);
});

test('detectMime: magic bytes beat extension', () => {
  assert.equal(detectMime(Buffer.from('%PDF-1.4 ...'), 'scan.jpg'), 'application/pdf');
  assert.equal(detectMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'x.pdf'), 'image/jpeg');
  assert.equal(detectMime(Buffer.from([0x89, 0x50, 0x4e, 0x47]), ''), 'image/png');
  assert.equal(detectMime(Buffer.from('hello'), 'notes.txt'), 'application/octet-stream');
  assert.equal(isSupported('application/pdf'), true); assert.equal(isSupported('application/octet-stream'), false);
});
test('estimatePageCount counts /Type /Page objects', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type /Page >>');
  assert.equal(estimatePageCount(pdf, 'application/pdf'), 2);
  assert.equal(estimatePageCount(Buffer.from('x'), 'image/jpeg'), 1);
});

test('parseAmount', () => {
  assert.equal(parseAmount('£1,200.00'), 1200); assert.equal(parseAmount('GBP 75.19'), 75.19);
  assert.equal(parseAmount('1,259.63'), 1259.63); assert.equal(parseAmount(''), null); assert.equal(parseAmount('abc'), null);
});

test('normaliseExtraction is defensive', () => {
  const e = normaliseExtraction({ invoice_number: ' INV1 ', invoice_date: '13/01/2026', totals: { gross: '12' }, line_items: [{ mpn: 'A', description: 'x', quantity: 2, unit_price: 1.005, line_total: 2.01 }], confidence: 1.7 });
  assert.equal(e.invoice_number, 'INV1'); assert.equal(e.invoice_date, null); assert.equal(e.totals.gross, null);
  assert.equal(e.line_items[0].unit_price, 1.01); assert.equal(e.confidence, 1); assert.equal(e.document_type, 'invoice');
  assert.deepEqual(normaliseExtraction(null).line_items, []);
});

test('rate limiter never exceeds capacity per window', async () => {
  let t = 0; const sleeps = [];
  const lim = createRateLimiter({ perMinute: 60, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
  for (let i = 0; i < 61; i++) await lim.take();
  assert.ok(sleeps.length >= 1, 'the 61st call must wait'); assert.ok(sleeps[0] >= 900 && sleeps[0] <= 1100);
});

test('mapWithConcurrency: captures errors, honours stop', async () => {
  const items = [1, 2, 3, 4, 5]; let calls = 0;
  const r = await mapWithConcurrency(items, 2, async (x) => { calls++; if (x === 3) throw new Error('boom'); return x * 2; }, { shouldStop: () => calls >= 4 });
  assert.equal(r.results[0].value, 2); assert.equal(r.results[2].ok, false); assert.ok(r.stopped);
});

test('buildBillPayload: whitelist, invoice number, partial quantities', () => {
  const template = { vendor_id: 'v1', date: '2026-11-03', reference_number: 'ref', purchaseorder_ids: ['po1'], currency_id: 'c',
    line_items: [{ purchaseorder_item_id: 'a', item_id: 'i1', name: 'A', account_id: 'acc', quantity: 10, rate: 2, tax_id: 't' }, { purchaseorder_item_id: 'b', item_id: 'i2', name: 'B', account_id: 'acc', quantity: 5, rate: 3 }] };
  const full = buildBillPayload({ template, invoiceNumber: 'X'.repeat(60), invoiceDate: '2026-01-05', paymentTermsDays: 30, paymentTermsLabel: 'Net 30' });
  assert.equal(full.bill_number.length, 50); assert.equal(full.date, '2026-01-05'); assert.equal(full.payment_terms, 30);
  assert.equal(full.line_items.length, 2); assert.equal(full.line_items[0].tax_id, 't'); assert.equal(full.line_items[1].tax_id, undefined);
  const partial = buildBillPayload({ template, invoiceNumber: 'P1', quantities: { a: 6, b: 0 } });
  assert.equal(partial.line_items.length, 1); assert.equal(partial.line_items[0].quantity, 6);
  assert.equal(partial.date, '2026-11-03');
});

test('paymentTermsFromPo matches by number of days, not label', () => {
  const terms = [{ payment_terms: 30, payment_terms_label: 'Net 30' }, { payment_terms: 30, payment_terms_label: 'Due end of next month' }];
  assert.deepEqual(paymentTermsFromPo({ payment_terms: 30, payment_terms_label: 'Due end of next month' }, terms), { days: 30, label: 'Due end of next month' });
  assert.equal(paymentTermsFromPo({}, terms), null);
});

test('config defaults are safe (dry-run on)', () => {
  const c = loadConfig({});
  assert.equal(c.run.dryRun, true); assert.equal(c.matching.totalTolerance, 0.02); assert.equal(c.books.ratePerMin, 80);
  assert.equal(loadConfig({ DRY_RUN: 'false' }).run.dryRun, false);
});
