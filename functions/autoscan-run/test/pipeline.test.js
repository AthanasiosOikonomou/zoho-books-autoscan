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
  const state = { docs: [...docs], bills: [...bills], created: [], attached: [], deleted: [] };
  const api = {
    stats: { calls: 0 },
    async getPaymentTerms() { calls.push('terms'); return [{ payment_terms: 30, payment_terms_label: 'Net 30' }]; },
    async listAllInboxDocuments() { calls.push('inbox'); return state.docs; },
    async downloadDocument(id) { calls.push(`download:${id}`); return { buffer: Buffer.concat([PDF, Buffer.from(id)]), fileName: `${id}.pdf` }; },
    async deleteDocument(id) { calls.push(`delete:${id}`); state.deleted.push(id); state.docs = state.docs.filter((d) => d.document_id !== id); return { code: 0 }; },
    async searchPurchaseOrders(q) { calls.push('po.search'); const v = q.purchaseorder_number || q.reference_number; return pos.filter((p) => p.purchaseorder_number === v || p.reference_number === v); },
    async getPurchaseOrder(id) { calls.push('po.get'); return pos.find((p) => p.purchaseorder_id === id); },
    async searchBills(q) { calls.push('bills.search'); return state.bills.filter((b) => (q.bill_number ? b.bill_number === q.bill_number && b.vendor_id === q.vendor_id : b.purchaseorder_id === q.purchaseorder_id)); },
    async getBillFromPurchaseOrders(poId) { calls.push('bill.editpage'); const po = pos.find((p) => p.purchaseorder_id === poId); return { vendor_id: po.vendor_id, date: '2026-11-03', purchaseorder_ids: [poId], line_items: po.line_items }; },
    async createBill(payload) { calls.push('bill.create'); const bill = { bill_id: `b${state.created.length + 1}`, bill_number: payload.bill_number, vendor_id: payload.vendor_id, status: 'open', total: payload.line_items.reduce((s, l) => s + l.quantity * l.rate, 0) }; state.created.push(bill); state.bills.push({ ...bill, purchaseorder_id: payload.purchaseorder_ids[0] }); return bill; },
    async markBillOpen() { calls.push('bill.open'); return { code: 0 }; },
    async attachToBill(id) { calls.push(`attach:${id}`); state.attached.push(id); return { code: 0 }; },
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
  { purchaseorder_id: 'po1', purchaseorder_number: 'PO-00001', vendor_id: 'v1', vendor_name: 'Vendor', total: 120, payment_terms: 30, line_items: [{ purchaseorder_item_id: 'x', item_id: 'i', name: 'A', account_id: 'a', quantity: 4, rate: 30 }] },
  { purchaseorder_id: 'po2', purchaseorder_number: 'PO-00002', vendor_id: 'v1', vendor_name: 'Vendor', total: 100, payment_terms: 30, line_items: [{ purchaseorder_item_id: 'y', item_id: 'i', name: 'B', account_id: 'a', quantity: 10, rate: 10 }] },
];

function cfg(over = {}) {
  const c = loadConfig({ BOOKS_ORG_ID: 'org', ...over });
  if (over.RETRY_AFTER_HOURS === undefined) c.run.retryAfterHours = 12;
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
  const ex = fakeExtractor({ d5: { po_reference: 'PO-00001', gross: 121 }, d6: { po_reference: 'PO-00001', gross: 120, confidence: 0.4 } });
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
