'use strict';

/**
 * End-to-end pipeline test with fakes: proves the queue behaviour and the
 * money-safety rules without touching Books or Claude.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { runAutoscan } = require('../src/pipeline/run');
const { JsonFileStore, STATUS } = require('../src/state/store');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >>');

function fakeBooks({ docs, pos, bills = [] }) {
  const calls = [];
  const state = { docs: [...docs], bills: [...bills], created: [], attached: [], deleted: [], credits: [], applied: [], creditAttached: [] };
  const api = {
    stats: { calls: 0 },
    async getPaymentTerms() { calls.push('terms'); return [{ payment_terms: 30, payment_terms_label: 'Net 30' }]; },
    async listAllInboxDocuments() { calls.push('inbox'); return state.docs; },
    async downloadDocument(id) { calls.push(`download:${id}`); return { buffer: Buffer.concat([PDF, Buffer.from(id)]), fileName: `${id}.pdf` }; },
    async deleteDocument(id) { calls.push(`delete:${id}`); state.deleted.push(id); state.docs = state.docs.filter((d) => d.document_id !== id); return { code: 0 }; },
    async searchPurchaseOrders(q) { calls.push('po.search'); const v = q.purchaseorder_number || q.reference_number; return pos.filter((p) => p.purchaseorder_number === v || p.reference_number === v); },
    async getPurchaseOrder(id) { calls.push('po.get'); return pos.find((p) => p.purchaseorder_id === id); },
    async searchBills(q) { calls.push('bills.search'); return state.bills.filter((b) => (q.bill_number ? b.bill_number === q.bill_number && b.vendor_id === q.vendor_id : b.purchaseorder_id === q.purchaseorder_id)); },
    async getBillFromPurchaseOrders(poId) { calls.push('bill.editpage'); const po = pos.find((p) => p.purchaseorder_id === poId); // like Books: the template is priced on the PO's *remaining* (un-billed) value
      const full = po.line_items.reduce((s, l) => s + l.quantity * l.rate, 0); const billedSoFar = state.bills.filter((b) => b.purchaseorder_id === poId).reduce((s, b) => s + Number(b.total || 0), 0);
      return { vendor_id: po.vendor_id, date: '2026-11-03', purchaseorder_ids: [poId], total: Math.round((full - billedSoFar) * 100) / 100, line_items: po.line_items }; },
    async createBill(payload) { calls.push('bill.create'); const bill = { bill_id: `b${state.created.length + 1}`, bill_number: payload.bill_number, vendor_id: payload.vendor_id, status: 'open', total: payload.line_items.reduce((s, l) => s + l.quantity * l.rate, 0) }; state.created.push(bill); state.bills.push({ ...bill, purchaseorder_id: payload.purchaseorder_ids[0] }); return bill; },
    async markBillOpen() { calls.push('bill.open'); return { code: 0 }; },
    async attachToBill(id) { calls.push(`attach:${id}`); state.attached.push(id); return { code: 0 }; },
    async getBill(id) { calls.push('bill.get'); const b = state.bills.find((x) => x.bill_id === id); return b ? { ...b, balance: b.balance !== undefined ? b.balance : b.total } : null; },
    // vendor credits
    async searchVendorCredits(q) { calls.push('credits.search'); return state.credits.filter((c) => c.vendor_id === q.vendor_id && c.vendor_credit_number === q.vendor_credit_number); },
    async createVendorCredit(payload) { calls.push('credit.create'); const c = { vendor_credit_id: `vc${state.credits.length + 1}`, vendor_credit_number: payload.vendor_credit_number, vendor_id: payload.vendor_id, status: 'draft', total: Math.round(payload.line_items.reduce((s, l) => s + l.quantity * l.rate * (l.tax_id ? 1.2 : 1), 0) * 100) / 100, payload }; state.credits.push(c); return c; },
    async markVendorCreditOpen(id) { calls.push(`credit.open:${id}`); return { code: 0 }; },
    async deleteVendorCredit(id) { calls.push(`credit.delete:${id}`); state.credits = state.credits.filter((c) => c.vendor_credit_id !== id); return { code: 0 }; },
    async applyVendorCreditToBill(creditId, billId, amount) { calls.push('credit.apply'); state.applied.push({ creditId, billId, amount }); return { code: 0 }; },
    async attachToVendorCredit(id) { calls.push(`credit.attach:${id}`); state.creditAttached.push(id); return { code: 0 }; },
  };
  return { api, calls, state };
}

function fakeExtractor(byDocId) {
  const seen = [];
  return {
    seen,
    async extract(buffer) {
      const id = buffer.toString('latin1').replace(/^.*>>/s, '');
      seen.push(id);
      const e = byDocId[id] || { po_reference: null };
      return {
        extraction: { document_type: 'invoice', invoice_number: `INV-${id}`, invoice_date: '2026-01-10', po_reference: e.po_reference, supplier_name: 'Vendor', totals: { net: null, vat: null, carriage: null, gross: e.gross ?? 120 }, line_items: [], confidence: e.confidence ?? 0.95, evidence: 'x', ...e.override },
        usage: { model: 'claude-haiku-5-5', input_tokens: 4000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        usages: [{ model: 'claude-haiku-5-5', input_tokens: 4000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
      };
    },
  };
}

function mailer() { const sent = []; return { sent, async send(r) { sent.push(r); } }; }
const logger = createLogger({ level: 'error' });

const pos = [
  { purchaseorder_id: 'po1', purchaseorder_number: 'PO-00001', vendor_id: 'v1', vendor_name: 'Vendor', total: 120, payment_terms: 30, line_items: [{ purchaseorder_item_id: 'x', item_id: 'i', name: 'A', account_id: 'a', quantity: 4, rate: 30, tax_id: 't20' }] }, // tax_id: the fake prices credits at ×1.2 like VAT
  { purchaseorder_id: 'po2', purchaseorder_number: 'PO-00002', vendor_id: 'v1', vendor_name: 'Vendor', total: 100, payment_terms: 30, line_items: [{ purchaseorder_item_id: 'y', item_id: 'i', name: 'B', account_id: 'a', quantity: 10, rate: 10 }] },
];

function cfg(over = {}) {
  const c = loadConfig({ BOOKS_ORG_ID: 'org', ...over });
  if (over.RETRY_AFTER_HOURS === undefined) c.run.retryAfterHours = 12;
  if (over.REPORT_PER_RUN === undefined) c.report.perRun = true; // the pipeline tests assert on per-run emails
  if (over.DAILY_REPORT_HOUR === undefined) c.report.dailyHour = null; // daily digest is tested on its own
  return c;
}

test('new doc with exact PO match is billed, attached, deleted; state BILLED', async () => {
  const books = fakeBooks({ docs: [{ document_id: 'd1', file_name: 'a.pdf', transactions: [] }], pos });
  const ex = fakeExtractor({ d1: { po_reference: 'PO-00001', gross: 120 } });
  const store = new JsonFileStore(); const m = mailer();
  const r = await runAutoscan({ config: cfg({ DRY_RUN: 'false' }), books: books.api, extractor: ex, store, mailer: m, logger });
  assert.equal(r.billed, 1); assert.equal(books.state.created.length, 1); assert.deepEqual(books.state.deleted, ['d1']);
  assert.equal(books.state.created[0].bill_number, 'INV-d1');
  const st = (await store.getByDocumentIds(['d1'])).get('d1');
  assert.equal(st.status, STATUS.BILLED); assert.equal(m.sent.length, 1);
});

test('dry-run writes nothing to Books but reports WOULD_BILL', async () => {
  const books = fakeBooks({ docs: [{ document_id: 'd1', file_name: 'a.pdf', transactions: [] }], pos });
  const ex = fakeExtractor({ d1: { po_reference: 'IPO/00001', gross: 120 } }); // legacy → candidates include PO-00001
  const store = new JsonFileStore(); const m = mailer();
  const r = await runAutoscan({ config: cfg(), books: books.api, extractor: ex, store, mailer: m, logger });
  assert.equal(books.state.created.length, 0); assert.equal(books.state.deleted.length, 0);
  assert.equal(r.results[0].status, STATUS.WOULD_BILL);
  assert.match(m.sent[0].subject, /DRY-RUN/);
});

test('exception stays in inbox, is NOT re-extracted, and is retried only after the window', async () => {
  const books = fakeBooks({ docs: [{ document_id: 'd2', file_name: 'b.pdf', transactions: [] }], pos });
  const ex = fakeExtractor({ d2: { po_reference: 'PO-09999', gross: 50 } });
  const store = new JsonFileStore(); const m = mailer();
  const t0 = new Date('2026-11-03T08:00:00Z');
  const config = cfg({ DRY_RUN: 'false' });

  const r1 = await runAutoscan({ config, books: books.api, extractor: ex, store, mailer: m, logger, now: () => t0 });
  assert.equal(r1.exceptions, 1); assert.equal(r1.results[0].reason_code, 'PO_NOT_FOUND'); assert.equal(ex.seen.length, 1);

  // 30 minutes later: nothing happens (known doc, retry window not reached)
  const r2 = await runAutoscan({ config, books: books.api, extractor: ex, store, mailer: m, logger, now: () => new Date(t0.getTime() + 30 * 60000) });
  assert.equal(r2.results.length, 0); assert.equal(ex.seen.length, 1); assert.equal(m.sent.length, 1, 'no email for an empty run');

  // finance creates the PO; 13 hours later the retry matches WITHOUT a new Claude call
  pos.push({ purchaseorder_id: 'po9', purchaseorder_number: 'PO-09999', vendor_id: 'v1', vendor_name: 'Vendor', total: 50, payment_terms: 30, line_items: [{ purchaseorder_item_id: 'z', item_id: 'i', name: 'C', account_id: 'a', quantity: 1, rate: 50 }] });
  const r3 = await runAutoscan({ config, books: books.api, extractor: ex, store, mailer: m, logger, now: () => new Date(t0.getTime() + 13 * 3600000) });
  assert.equal(r3.retried, 1); assert.equal(r3.billed, 1); assert.equal(ex.seen.length, 1, 'extraction reused');
  pos.pop();
});

test('duplicate supplier invoice number → DUPLICATE, nothing created, file kept', async () => {
  const books = fakeBooks({ docs: [{ document_id: 'd3', file_name: 'c.pdf', transactions: [] }], pos, bills: [{ bill_id: 'old', bill_number: 'INV-d3', vendor_id: 'v1', total: 120 }] });
  const ex = fakeExtractor({ d3: { po_reference: 'PO-00001', gross: 120 } });
  const store = new JsonFileStore(); const m = mailer();
  const r = await runAutoscan({ config: cfg({ DRY_RUN: 'false' }), books: books.api, extractor: ex, store, mailer: m, logger });
  assert.equal(r.results[0].status, STATUS.DUPLICATE); assert.equal(books.state.created.length, 0); assert.equal(books.state.deleted.length, 0);
});

test('a PO with an existing bill still gets a NEW bill for a different invoice (partial deliveries)', async () => {
  const books = fakeBooks({ docs: [{ document_id: 'd4', file_name: 'd.pdf', transactions: [] }], pos, bills: [{ bill_id: 'b-old', bill_number: 'INV-OLD', vendor_id: 'v1', total: 60, purchaseorder_id: 'po2' }] });
  const ex = fakeExtractor({ d4: { po_reference: 'PO-00002', gross: 40 } }); // closing invoice: 100 - 60 = 40
  const store = new JsonFileStore(); const m = mailer();
  const r = await runAutoscan({ config: cfg({ DRY_RUN: 'false' }), books: books.api, extractor: ex, store, mailer: m, logger });
  assert.equal(r.billed, 1); assert.equal(r.results[0].match.basis, 'remaining'); assert.equal(books.state.created.length, 1);
});

test('total mismatch and low confidence are exceptions; docs with transactions are skipped', async () => {
  const books = fakeBooks({ docs: [
    { document_id: 'd5', file_name: 'e.pdf', transactions: [] },
    { document_id: 'd6', file_name: 'f.pdf', transactions: [] },
    { document_id: 'd7', file_name: 'g.pdf', transactions: [{ transaction_id: 't' }] },
  ], pos });
  const ex = fakeExtractor({ d5: { po_reference: 'PO-00001', gross: 122 }, d6: { po_reference: 'PO-00001', gross: 120, confidence: 0.4 } }); // £2 over: outside the £1 tolerance
  const store = new JsonFileStore(); const m = mailer();
  const r = await runAutoscan({ config: cfg({ DRY_RUN: 'false' }), books: books.api, extractor: ex, store, mailer: m, logger });
  const by = Object.fromEntries(r.results.map((x) => [x.document_id, x.reason_code]));
  assert.equal(by.d5, 'TOTAL_MISMATCH'); assert.equal(by.d6, 'LOW_CONFIDENCE'); assert.equal(by.d7, undefined);
  assert.equal(books.state.created.length, 0);
});

test('same file re-uploaded under a new document id reuses the extraction (no Claude call)', async () => {
  const books = fakeBooks({ docs: [{ document_id: 'd8', file_name: 'h.pdf', transactions: [] }], pos });
  books.api.downloadDocument = async () => ({ buffer: Buffer.concat([PDF, Buffer.from('d8')]), fileName: 'h.pdf' });
  const ex = fakeExtractor({ d8: { po_reference: 'PO-00001', gross: 121 } });
  const store = new JsonFileStore(); const m = mailer();
  const config = cfg({ DRY_RUN: 'false' });
  await runAutoscan({ config, books: books.api, extractor: ex, store, mailer: m, logger });
  books.state.docs.push({ document_id: 'd9', file_name: 'h-again.pdf', transactions: [] });
  await runAutoscan({ config, books: books.api, extractor: ex, store, mailer: m, logger, now: () => new Date(Date.now() + 60000) });
  assert.equal(ex.seen.length, 1);
});

test('run lock: a fresh RUNNING run makes the next run skip', async () => {
  const books = fakeBooks({ docs: [], pos });
  const store = new JsonFileStore(); const m = mailer();
  await store.beginRun({ run_id: 'other', started: new Date().toISOString() });
  const r = await runAutoscan({ config: cfg(), books: books.api, extractor: fakeExtractor({}), store, mailer: m, logger });
  assert.equal(r.skipped, true);
});

test('documents marked WOULD_BILL in dry-run are billed by the first live run', async () => {
  const books = fakeBooks({ docs: [{ document_id: 'd10', file_name: 'i.pdf', transactions: [] }], pos });
  const ex = fakeExtractor({ d10: { po_reference: 'PO-00001', gross: 120 } });
  const store = new JsonFileStore(); const m = mailer();
  const t0 = new Date('2026-11-03T08:00:00Z');
  const dry = await runAutoscan({ config: cfg(), books: books.api, extractor: ex, store, mailer: m, logger, now: () => t0 });
  assert.equal(dry.results[0].status, STATUS.WOULD_BILL); assert.equal(books.state.created.length, 0);
  const live = await runAutoscan({ config: cfg({ DRY_RUN: 'false', RETRY_AFTER_HOURS: '0' }), books: books.api, extractor: ex, store, mailer: m, logger, now: () => new Date(t0.getTime() + 60000) });
  assert.equal(live.billed, 1); assert.equal(books.state.created.length, 1); assert.equal(ex.seen.length, 1, 'no second extraction');
});

test('a prompt change re-reads extraction-related exceptions but not total mismatches', async () => {
  const books = fakeBooks({ docs: [
    { document_id: 'd11', file_name: 'j.pdf', transactions: [] },
    { document_id: 'd12', file_name: 'k.pdf', transactions: [] },
  ], pos });
  const ex = fakeExtractor({ d11: { po_reference: null }, d12: { po_reference: 'PO-00001', gross: 999 } });
  ex.promptVersion = 'v1';
  const store = new JsonFileStore(); const m = mailer();
  const t0 = new Date('2026-11-03T08:00:00Z');
  const config = cfg({ DRY_RUN: 'false', RETRY_AFTER_HOURS: '0' });
  const r1 = await runAutoscan({ config, books: books.api, extractor: ex, store, mailer: m, logger, now: () => t0 });
  const by1 = Object.fromEntries(r1.results.map((x) => [x.document_id, x.reason_code]));
  assert.equal(by1.d11, 'NO_PO_REF'); assert.equal(by1.d12, 'TOTAL_MISMATCH'); assert.equal(ex.seen.length, 2);

  ex.promptVersion = 'v2'; // prompt improved
  await runAutoscan({ config, books: books.api, extractor: ex, store, mailer: m, logger, now: () => new Date(t0.getTime() + 60000) });
  assert.deepEqual(ex.seen.slice(2), ['d11'], 'only the NO_PO_REF document was re-read');
});

test('two copies of the same invoice in one batch: one bill, the other DUPLICATE, never a Books error', async () => {
  const books = fakeBooks({ docs: [
    { document_id: 'd20', file_name: 'copy1.pdf', transactions: [] },
    { document_id: 'd21', file_name: 'copy2.pdf', transactions: [] },
  ], pos });
  const ex = fakeExtractor({ d20: { po_reference: 'PO-00001', gross: 120, override: { invoice_number: 'SAME-1' } }, d21: { po_reference: 'PO-00001', gross: 120, override: { invoice_number: 'SAME-1' } } });
  const store = new JsonFileStore(); const m = mailer();
  const r = await runAutoscan({ config: cfg({ DRY_RUN: 'false' }), books: books.api, extractor: ex, store, mailer: m, logger });
  const statuses = r.results.map((x) => x.status).sort();
  assert.deepEqual(statuses, [STATUS.BILLED, STATUS.DUPLICATE]);
  assert.equal(books.state.created.length, 1);
});

test('bill is NOT created when the PO template total differs from the invoice', async () => {
  const books = fakeBooks({ docs: [{ document_id: 'd30', file_name: 't.pdf', transactions: [] }], pos });
  books.api.getBillFromPurchaseOrders = async () => ({ vendor_id: 'v1', date: '2026-11-03', purchaseorder_ids: ['po1'], total: 999, line_items: pos[0].line_items });
  const ex = fakeExtractor({ d30: { po_reference: 'PO-00001', gross: 120 } });
  const store = new JsonFileStore(); const m = mailer();
  const r = await runAutoscan({ config: cfg({ DRY_RUN: 'false' }), books: books.api, extractor: ex, store, mailer: m, logger });
  assert.equal(r.results[0].reason_code, 'BILL_TEMPLATE_MISMATCH'); assert.equal(books.state.created.length, 0);
});

test('credit note against a billed invoice → vendor credit created, opened, applied to that bill, attached, inbox file deleted', async () => {
  const books = fakeBooks({ docs: [{ document_id: 'cn1', file_name: 'cn.pdf', transactions: [] }], pos, bills: [{ bill_id: 'b-inv', bill_number: 'INV-900', vendor_id: 'v1', total: 120, purchaseorder_id: 'po1' }] });
  const ex = fakeExtractor({ cn1: { po_reference: 'PO-00001', gross: 36, override: { document_type: 'credit_note', invoice_number: 'CN-77', related_invoice_number: 'INV-900', totals: { net: 30, vat: 6, carriage: null, gross: 36 }, line_items: [{ mpn: 'A', description: 'Returned item', quantity: 1, unit_price: 30, line_total: 30 }] } } });
  const store = new JsonFileStore();
  const r = await runAutoscan({ config: cfg({ DRY_RUN: 'false' }), books: books.api, extractor: ex, store, mailer: mailer(), logger });
  const x = r.results[0];
  assert.equal(x.status, STATUS.CREDITED); assert.equal(r.credited, 1); assert.equal(r.exceptions, 0);
  assert.equal(books.state.credits.length, 1); assert.equal(books.state.credits[0].payload.vendor_credit_number, 'CN-77'); assert.equal(books.state.credits[0].payload.reference_number, 'PO-00001');
  assert.equal(books.state.credits[0].payload.line_items[0].item_id, 'i', 'line mapped to the PO line (name contains the MPN)');
  assert.deepEqual(books.state.applied, [{ creditId: 'vc1', billId: 'b-inv', amount: 36 }]);
  assert.deepEqual(books.state.creditAttached, ['vc1']); assert.deepEqual(books.state.deleted, ['cn1']);
  assert.equal(x.credit.bill, 'INV-900'); assert.equal(x.note, null);
  const rec = (await store.getByDocumentIds(['cn1'])).get('cn1'); assert.equal(rec.credit_id, 'vc1'); assert.equal(rec.bill_id, 'b-inv');
  assert.equal(books.state.created.length, 0, 'no bill created');
});
test('credit note with PO only (no invoice reference, PO has several bills) → vendor credit on the PO, reported as not linked', async () => {
  const books = fakeBooks({ docs: [{ document_id: 'cn2', file_name: 'cn2.pdf', transactions: [] }], pos, bills: [{ bill_id: 'b1', bill_number: 'INV-1', vendor_id: 'v1', total: 60, purchaseorder_id: 'po1' }, { bill_id: 'b2', bill_number: 'INV-2', vendor_id: 'v1', total: 60, purchaseorder_id: 'po1' }] });
  const ex = fakeExtractor({ cn2: { po_reference: 'PO-00001', gross: 12, override: { document_type: 'credit_note', invoice_number: 'CN-78', related_invoice_number: null, totals: { net: 10, vat: 2, carriage: null, gross: 12 }, line_items: [{ mpn: 'ZZZ', description: 'Shortage', quantity: 1, unit_price: 10, line_total: 10 }] } } });
  const r = await runAutoscan({ config: cfg({ DRY_RUN: 'false' }), books: books.api, extractor: ex, store: new JsonFileStore(), mailer: mailer(), logger });
  const x = r.results[0];
  assert.equal(x.status, STATUS.CREDITED); assert.equal(x.credit.bill, null); assert.match(x.note, /not linked to any bill/);
  assert.equal(books.state.applied.length, 0); assert.equal(books.state.credits[0].payload.line_items[0].account_id, 'a', 'unmatched MPN → first PO line account');
});
test('credit note: same number twice → DUPLICATE; dry-run → WOULD_CREDIT and nothing written', async () => {
  const books = fakeBooks({ docs: [{ document_id: 'cn3', file_name: 'cn3.pdf', transactions: [] }], pos });
  books.state.credits.push({ vendor_credit_id: 'old', vendor_credit_number: 'CN-79', vendor_id: 'v1', total: 12 });
  const ex = fakeExtractor({ cn3: { po_reference: 'PO-00001', gross: 12, override: { document_type: 'credit_note', invoice_number: 'CN-79', totals: { net: 10, vat: 2, carriage: null, gross: 12 }, line_items: [] } } });
  const r = await runAutoscan({ config: cfg({ DRY_RUN: 'false' }), books: books.api, extractor: ex, store: new JsonFileStore(), mailer: mailer(), logger });
  assert.equal(r.results[0].status, STATUS.DUPLICATE); assert.equal(books.state.credits.length, 1);
  const books2 = fakeBooks({ docs: [{ document_id: 'cn4', file_name: 'cn4.pdf', transactions: [] }], pos });
  const ex2 = fakeExtractor({ cn4: { po_reference: 'PO-00001', gross: 12, override: { document_type: 'credit_note', invoice_number: 'CN-80', totals: { net: 10, vat: 2, carriage: null, gross: 12 }, line_items: [] } } });
  const r2 = await runAutoscan({ config: cfg(), books: books2.api, extractor: ex2, store: new JsonFileStore(), mailer: mailer(), logger });
  assert.equal(r2.results[0].status, STATUS.WOULD_CREDIT); assert.equal(r2.would_credit, 1); assert.equal(books2.state.credits.length, 0);
});
test('credit note whose Books total differs from the printed total → credit deleted again, CREDIT_TOTAL_MISMATCH', async () => {
  const books = fakeBooks({ docs: [{ document_id: 'cn5', file_name: 'cn5.pdf', transactions: [] }], pos });
  const ex = fakeExtractor({ cn5: { po_reference: 'PO-00001', gross: 50, override: { document_type: 'credit_note', invoice_number: 'CN-81', totals: { net: 30, vat: 20, carriage: null, gross: 50 }, line_items: [{ mpn: 'A', description: 'x', quantity: 1, unit_price: 30, line_total: 30 }] } } });
  const r = await runAutoscan({ config: cfg({ DRY_RUN: 'false' }), books: books.api, extractor: ex, store: new JsonFileStore(), mailer: mailer(), logger });
  assert.equal(r.results[0].reason_code, 'CREDIT_TOTAL_MISMATCH'); assert.equal(books.state.credits.length, 0, 'draft credit removed'); assert.ok(books.calls.includes('credit.delete:vc1'));
});

test('bill is posted with the invoice total: 40p over the PO within the £1 tolerance → adjustment 0.40 on the bill', async () => {
  const books = fakeBooks({ docs: [{ document_id: 'adj1', file_name: 'adj.pdf', transactions: [] }], pos });
  const ex = fakeExtractor({ adj1: { po_reference: 'PO-00001', gross: 120.4 } });
  const seen = [];
  const orig = books.api.createBill; books.api.createBill = async (payload) => { seen.push(payload); const b = await orig(payload); b.total = b.total + (payload.adjustment || 0); return b; };
  const r = await runAutoscan({ config: cfg({ DRY_RUN: 'false' }), books: books.api, extractor: ex, store: new JsonFileStore(), mailer: mailer(), logger });
  assert.equal(r.billed, 1); assert.equal(seen[0].adjustment, 0.4); assert.equal(r.results[0].note, undefined, 'bill total equals the invoice → no note');
});
test('bill created but Books ignored the adjustment → BILLED with a visible note', async () => {
  const books = fakeBooks({ docs: [{ document_id: 'adj2', file_name: 'adj2.pdf', transactions: [] }], pos });
  const ex = fakeExtractor({ adj2: { po_reference: 'PO-00001', gross: 120.4 } });
  const r = await runAutoscan({ config: cfg({ DRY_RUN: 'false' }), books: books.api, extractor: ex, store: new JsonFileStore(), mailer: mailer(), logger });
  assert.equal(r.billed, 1); assert.match(r.results[0].note, /120\.00 differs from invoice 120\.40/);
});
