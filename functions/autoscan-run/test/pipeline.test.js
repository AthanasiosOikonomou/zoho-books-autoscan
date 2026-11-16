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
  const state = { docs: [...docs], bills: [...bills], created: [], attached: [], deleted: [], credits: [], applied: [], creditAttached: [], contacts: {}, items: {} };
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
      const lines = po.line_items.map((l) => ({ ...l, purchaseorder_item_id: l.purchaseorder_item_id || l.line_item_id, quantity: Math.max(0, (l.quantity || 0) - (l.quantity_billed || 0)) })).filter((l) => l.quantity > 0);
      const taxFactor = state.taxOnBills ? 1.2 : 1; // Phase 2 tests run in a world with 20% VAT on bills and templates; Phase 1 tests are tax-free
      return { vendor_id: po.vendor_id, date: '2026-11-03', purchaseorder_ids: [poId], total: Math.round((full - billedSoFar) * taxFactor * 100) / 100, line_items: lines }; },
    async createBill(payload) { calls.push('bill.create'); const net = payload.line_items.reduce((s, l) => s + l.quantity * l.rate, 0); const tax = state.taxOnBills ? payload.line_items.reduce((s, l) => s + (l.tax_id ? l.quantity * l.rate * 0.2 : 0), 0) : 0;
      const bill = { bill_id: `b${state.created.length + 1}`, bill_number: payload.bill_number, vendor_id: payload.vendor_id, status: 'open', total: Math.round((net + tax + (payload.adjustment || 0)) * 100) / 100, payload }; state.created.push(bill); state.bills.push({ ...bill, purchaseorder_id: payload.purchaseorder_ids[0] }); return bill; },
    async getContact(id) { calls.push('contact.get'); return state.contacts[id] || { contact_id: id, custom_fields: [] }; },
    async getItem(id) { calls.push(`item.get:${id}`); return state.items[id] || null; },
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

test('a prompt change re-reads documents parked for a reading or matching reason — once', async () => {
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
  assert.deepEqual(ex.seen.slice(2).sort(), ['d11', 'd12'], 'the unread PO reference and the total mismatch (a possible misread) are both read again');
  await runAutoscan({ config, books: books.api, extractor: ex, store, mailer: m, logger, now: () => new Date(t0.getTime() + 120000) });
  assert.equal(ex.seen.length, 4, 'same prompt on the next retry: the stored extraction is reused, no AI call');
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
  const r = await runAutoscan({ config: cfg({ DRY_RUN: 'false' }), books: books.api, extractor: ex, store: new JsonFileStore(), mailer: mailer(), logger });
  assert.equal(r.billed, 1); assert.equal(books.state.created[0].payload.adjustment, 0.4); assert.equal(books.state.created[0].total, 120.4); assert.equal(r.results[0].note, undefined, 'bill total equals the invoice → no note');
});
test('bill created but Books ignored the adjustment → BILLED with a visible note', async () => {
  const books = fakeBooks({ docs: [{ document_id: 'adj2', file_name: 'adj2.pdf', transactions: [] }], pos });
  const orig = books.api.createBill; books.api.createBill = async (payload) => orig({ ...payload, adjustment: 0 }); // Books "drops" the adjustment
  const ex = fakeExtractor({ adj2: { po_reference: 'PO-00001', gross: 120.4 } });
  const r = await runAutoscan({ config: cfg({ DRY_RUN: 'false' }), books: books.api, extractor: ex, store: new JsonFileStore(), mailer: mailer(), logger });
  assert.equal(r.billed, 1); assert.match(r.results[0].note, /120\.00 differs from invoice 120\.40/);
});

// ---------------------------------------------------------------- Phase 2 (line matching, partial bills)
const P2 = { PHASE2_ENABLED: 'true', DRY_RUN: 'false' };
const poLine = (id, ref, qty, rate, extra = {}) => ({ line_item_id: id, purchaseorder_item_id: id, item_id: `it-${id}`, name: `Item ${id}`, account_id: 'a', quantity: qty, quantity_billed: 0, rate, tax_id: 't20', tax_percentage: 20, item_custom_fields: ref ? [{ label: 'Supplier Reference', value: ref }] : [], ...extra });
function p2Extractor(byDocId) { // same as fakeExtractor but with real lines and carriage
  const base = fakeExtractor({});
  return { seen: base.seen, async extract(buffer) { const id = buffer.toString('latin1').replace(/^.*>>/s, ''); base.seen.push(id); const e = byDocId[id]; const net = e.lines.reduce((s, l) => s + l.quantity * l.unit_price, 0) + (e.carriage || 0);
    return { extraction: { document_type: 'invoice', invoice_number: `INV-${id}`, invoice_date: '2026-11-05', po_reference: e.po_reference, supplier_name: 'Vendor', totals: { net: r2(net), vat: r2(net * 0.2), carriage: e.carriage ?? null, gross: r2(net * 1.2) }, line_items: e.lines.map((l) => ({ description: l.mpn, line_total: r2(l.quantity * l.unit_price), ...l })), confidence: 0.96, evidence: 'x' },
      usage: { model: 'claude-haiku-5-5', input_tokens: 4000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, usages: [{ model: 'claude-haiku-5-5', input_tokens: 4000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }] }; } };
}
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const vendorCf = (rule, tol) => ({ contact_id: 'v1', custom_fields: [{ label: 'Carriage Rule', value: rule }, { label: 'Carriage Tolerance', value: tol }] });

test('phase 2: partial delivery billed at the invoice prices with only the invoiced lines; closing invoice bills the rest', async () => {
  const pos2 = [{ purchaseorder_id: 'po5', purchaseorder_number: 'PO-00050', vendor_id: 'v1', vendor_name: 'Vendor', total: r2((10 * 34 + 6 * 48.75) * 1.2), payment_terms: 30, line_items: [poLine('p', 'CP-PR5', 10, 34), poLine('e', 'CP-EM10M', 6, 48.75)] }];
  const books = fakeBooks({ docs: [{ document_id: 'pa', file_name: 'partial-A.pdf', transactions: [] }], pos: pos2 });
  books.state.contacts.v1 = vendorCf('Zero', 0); books.state.taxOnBills = true;
  const ex = p2Extractor({ pa: { po_reference: 'PO-00050', lines: [{ mpn: 'CP-PR5', quantity: 6, unit_price: 33.5 }] } }); // 6 of 10, 1.5% cheaper
  const store = new JsonFileStore();
  const r = await runAutoscan({ config: cfg(P2), books: books.api, extractor: ex, store, mailer: mailer(), logger });
  assert.equal(r.results[0].status, STATUS.BILLED, JSON.stringify(r.results[0].reason_text));
  const bill = books.state.created[0];
  assert.deepEqual(bill.payload.line_items.map((l) => [l.purchaseorder_item_id, l.quantity, l.rate]), [['p', 6, 33.5]], 'only the invoiced line, at the invoice price');
  assert.equal(bill.total, r2(6 * 33.5 * 1.2)); assert.match(r.results[0].note, /-1\.5%, billed at the invoice price/, 'lower within tolerance → billed at the invoice price, noted');
  assert.equal(r.results[0].lines.partial, true); assert.equal(r.results[0].match.basis, 'lines');
  // closing invoice: Books now says 4 remaining on p (fake template subtracts quantity_billed)
  pos2[0].line_items[0].quantity_billed = 6;
  books.state.docs.push({ document_id: 'pb', file_name: 'partial-B.pdf', transactions: [] });
  const ex2 = p2Extractor({ pb: { po_reference: 'PO-00050', lines: [{ mpn: 'CP-PR5', quantity: 4, unit_price: 34 }, { mpn: 'CP-EM10M', quantity: 6, unit_price: 48.75 }] } });
  const r2_ = await runAutoscan({ config: cfg(P2), books: books.api, extractor: ex2, store, mailer: mailer(), logger });
  assert.equal(r2_.results[0].status, STATUS.BILLED, r2_.results[0].reason_text);
  assert.deepEqual(books.state.created[1].payload.line_items.map((l) => [l.purchaseorder_item_id, l.quantity]), [['p', 4], ['e', 6]]);
  assert.equal(r2_.results[0].lines.partial, false);
});
test('phase 2: carriage — Zero flags, Fixed within tolerance bills the invoice carriage on the PO carriage line, no PO carriage line → extra line', async () => {
  const mk = (rule, tol, poCarriage) => {
    const lines = [poLine('a', 'RX-4402', 12, 11.2)]; if (poCarriage) lines.push(poLine('c', null, 1, poCarriage, { name: 'Carriage', item_id: 'it-carr' }));
    const pos2 = [{ purchaseorder_id: 'po6', purchaseorder_number: 'PO-00060', vendor_id: 'v1', vendor_name: 'Vendor', total: 0, payment_terms: 30, line_items: lines }];
    const books = fakeBooks({ docs: [{ document_id: 'cz', file_name: 'c.pdf', transactions: [] }], pos: pos2 }); books.state.contacts.v1 = vendorCf(rule, tol); books.state.taxOnBills = true;
    return books;
  };
  const ex = () => p2Extractor({ cz: { po_reference: 'PO-00060', lines: [{ mpn: 'RX-4402', quantity: 12, unit_price: 11.2 }], carriage: 12.5 } });
  const z = await runAutoscan({ config: cfg(P2), books: mk('Zero', 0, 10).api, extractor: ex(), store: new JsonFileStore(), mailer: mailer(), logger });
  assert.equal(z.results[0].reason_code, 'CARRIAGE_MISMATCH');
  const fBooks = mk('Fixed', 5, 10);
  const f = await runAutoscan({ config: cfg(P2), books: fBooks.api, extractor: ex(), store: new JsonFileStore(), mailer: mailer(), logger });
  assert.equal(f.results[0].status, STATUS.BILLED, f.results[0].reason_text);
  assert.deepEqual(fBooks.state.created[0].payload.line_items.map((l) => [l.purchaseorder_item_id, l.quantity, l.rate]), [['a', 12, 11.2], ['c', 1, 12.5]]);
  const nBooks = mk('Ignore', 0, 0);
  const n = await runAutoscan({ config: cfg({ ...P2, CARRIAGE_ITEM_ID: 'it-carr' }), books: nBooks.api, extractor: ex(), store: new JsonFileStore(), mailer: mailer(), logger });
  assert.equal(n.results[0].status, STATUS.BILLED, n.results[0].reason_text);
  const extra = nBooks.state.created[0].payload.line_items.find((l) => !l.purchaseorder_item_id);
  assert.deepEqual([extra.item_id, extra.quantity, extra.rate, extra.tax_id], ['it-carr', 1, 12.5, 't20']);
  assert.equal(nBooks.state.created[0].total, r2((134.4 + 12.5) * 1.2), 'bill total = invoice total');
  // per-supplier carriage items: no single item → the added line is booked on the freight account
  const aBooks = mk('Ignore', 0, 0);
  const a = await runAutoscan({ config: cfg({ ...P2, CARRIAGE_ACCOUNT_ID: 'acc-freight' }), books: aBooks.api, extractor: ex(), store: new JsonFileStore(), mailer: mailer(), logger });
  assert.equal(a.results[0].status, STATUS.BILLED, a.results[0].reason_text);
  const viaAccount = aBooks.state.created[0].payload.line_items.find((l) => !l.purchaseorder_item_id);
  assert.deepEqual([viaAccount.item_id, viaAccount.account_id, viaAccount.rate, viaAccount.tax_id], [undefined, 'acc-freight', 12.5, 't20']);
  // neither configured → the first product line's account
  const dBooks = mk('Ignore', 0, 0);
  const d = await runAutoscan({ config: cfg(P2), books: dBooks.api, extractor: ex(), store: new JsonFileStore(), mailer: mailer(), logger });
  const viaFirst = dBooks.state.created[0].payload.line_items.find((l) => !l.purchaseorder_item_id);
  assert.equal(d.results[0].status, STATUS.BILLED); assert.deepEqual([viaFirst.item_id, viaFirst.account_id], [undefined, 'a']);
});
test('phase 2: any price increase → PRICE_MISMATCH; up to 5% lower → BILLED at the invoice price with a note; further below → PRICE_MISMATCH; keyless PO → Phase 1 totals', async () => {
  const pos2 = [{ purchaseorder_id: 'po7', purchaseorder_number: 'PO-00070', vendor_id: 'v1', vendor_name: 'Vendor', total: r2(3 * 34 * 1.2), payment_terms: 30, line_items: [poLine('p', 'CP-PR5', 3, 34)] }];
  const books = fakeBooks({ docs: [{ document_id: 'hi', file_name: 'hi.pdf', transactions: [] }], pos: pos2 }); books.state.contacts.v1 = vendorCf('Zero', 0); books.state.taxOnBills = true;
  const hi = await runAutoscan({ config: cfg(P2), books: books.api, extractor: p2Extractor({ hi: { po_reference: 'PO-00070', lines: [{ mpn: 'CP-PR5', quantity: 3, unit_price: 38 }] } }), store: new JsonFileStore(), mailer: mailer(), logger });
  assert.equal(hi.results[0].reason_code, 'PRICE_MISMATCH'); assert.equal(books.state.created.length, 0);
  const books2 = fakeBooks({ docs: [{ document_id: 'lo', file_name: 'lo.pdf', transactions: [] }], pos: pos2 }); books2.state.contacts.v1 = vendorCf('Zero', 0); books2.state.taxOnBills = true;
  const lo = await runAutoscan({ config: cfg(P2), books: books2.api, extractor: p2Extractor({ lo: { po_reference: 'PO-00070', lines: [{ mpn: 'CP-PR5', quantity: 3, unit_price: 33 }] } }), store: new JsonFileStore(), mailer: mailer(), logger }); // −2.9%
  assert.equal(lo.results[0].status, STATUS.BILLED, lo.results[0].reason_text); assert.match(lo.results[0].note, /-2\.9%, billed at the invoice price/); assert.equal(books2.state.created[0].payload.line_items[0].rate, 33);
  const books4 = fakeBooks({ docs: [{ document_id: 'vl', file_name: 'vl.pdf', transactions: [] }], pos: pos2 }); books4.state.contacts.v1 = vendorCf('Zero', 0); books4.state.taxOnBills = true;
  const vl = await runAutoscan({ config: cfg(P2), books: books4.api, extractor: p2Extractor({ vl: { po_reference: 'PO-00070', lines: [{ mpn: 'CP-PR5', quantity: 3, unit_price: 25 }] } }), store: new JsonFileStore(), mailer: mailer(), logger }); // −26%
  assert.equal(vl.results[0].reason_code, 'PRICE_MISMATCH'); assert.match(vl.results[0].reason_text, /allowed down to -5%/); assert.equal(books4.state.created.length, 0);
  const books5 = fakeBooks({ docs: [{ document_id: 'sm', file_name: 'sm.pdf', transactions: [] }], pos: pos2 }); books5.state.contacts.v1 = vendorCf('Zero', 0); books5.state.taxOnBills = true;
  const sm = await runAutoscan({ config: cfg(P2), books: books5.api, extractor: p2Extractor({ sm: { po_reference: 'PO-00070', lines: [{ mpn: 'CP-PR5', quantity: 3, unit_price: 34.5 }] } }), store: new JsonFileStore(), mailer: mailer(), logger }); // +1.5%
  assert.equal(sm.results[0].reason_code, 'PRICE_MISMATCH'); assert.match(sm.results[0].reason_text, /price increases always go to review/); assert.equal(books5.state.created.length, 0);
  const posK = [{ purchaseorder_id: 'po8', purchaseorder_number: 'PO-00080', vendor_id: 'v1', vendor_name: 'Vendor', total: 120, payment_terms: 30, line_items: [poLine('k', null, 4, 25)] }];
  const books3 = fakeBooks({ docs: [{ document_id: 'kl', file_name: 'kl.pdf', transactions: [] }], pos: posK }); books3.state.contacts.v1 = vendorCf('Zero', 0); books3.state.taxOnBills = true;
  const kl = await runAutoscan({ config: cfg(P2), books: books3.api, extractor: p2Extractor({ kl: { po_reference: 'PO-00080', lines: [{ mpn: 'ZZ-1', quantity: 4, unit_price: 25 }] } }), store: new JsonFileStore(), mailer: mailer(), logger });
  assert.equal(kl.results[0].status, STATUS.BILLED, kl.results[0].reason_text); assert.equal(kl.results[0].lines.fallback, 'totals'); assert.equal(kl.results[0].match.basis, 'po_total');
  assert.ok(books3.calls.includes('item.get:it-k'), 'keyless PO line → item looked up for an MPN');
});

test('phase 2: carriage below the PO is billed as invoiced on the PO carriage line under rule Zero; none invoiced leaves that line open and the later carriage-only invoice bills it; the notes are stored for the digest', async () => {
  const mk = (docs) => {
    const pos2 = [{ purchaseorder_id: 'po9', purchaseorder_number: 'PO-00090', vendor_id: 'v1', vendor_name: 'Vendor', total: 0, payment_terms: 30, line_items: [poLine('a', 'RX-4402', 12, 11.2), poLine('c', null, 1, 12, { name: 'Carriage', item_id: 'it-carr' })] }];
    const books = fakeBooks({ docs, pos: pos2 }); books.state.contacts.v1 = vendorCf('Zero', 0); books.state.taxOnBills = true;
    return { books, pos2 };
  };
  const goods = [{ mpn: 'RX-4402', quantity: 12, unit_price: 11.2 }];
  // 4.99 invoiced against 12.00 on the PO
  const lo = mk([{ document_id: 'cl', file_name: 'lower.pdf', transactions: [] }]); const store = new JsonFileStore();
  const r = await runAutoscan({ config: cfg(P2), books: lo.books.api, extractor: p2Extractor({ cl: { po_reference: 'PO-00090', lines: goods, carriage: 4.99 } }), store, mailer: mailer(), logger });
  assert.equal(r.results[0].status, STATUS.BILLED, r.results[0].reason_text);
  assert.deepEqual(lo.books.state.created[0].payload.line_items.map((l) => [l.purchaseorder_item_id, l.quantity, l.rate]), [['a', 12, 11.2], ['c', 1, 4.99]], 'the PO carriage line is billed in full at the invoice figure → the PO completes');
  assert.equal(lo.books.state.created[0].total, r2((134.4 + 4.99) * 1.2));
  const st = (await store.getByDocumentIds(['cl'])).get('cl');
  assert.equal(st.status, STATUS.BILLED); assert.ok(!st.reason_code); assert.match(st.reason_text, /carriage 4\.99 invoiced vs 12\.00 on the PO — billed as invoiced/);
  // no carriage on the goods invoice, then the supplier's separate carriage invoice
  const no = mk([{ document_id: 'cn', file_name: 'goods.pdf', transactions: [] }]); const store2 = new JsonFileStore();
  const g = await runAutoscan({ config: cfg(P2), books: no.books.api, extractor: p2Extractor({ cn: { po_reference: 'PO-00090', lines: goods } }), store: store2, mailer: mailer(), logger });
  assert.equal(g.results[0].status, STATUS.BILLED, g.results[0].reason_text);
  assert.deepEqual(no.books.state.created[0].payload.line_items.map((l) => [l.purchaseorder_item_id, l.quantity, l.rate]), [['a', 12, 11.2]], 'the carriage line is not billed: the PO stays partially billed');
  assert.match(g.results[0].note, /no carriage on the invoice — 12\.00 stays open on the PO for a separate carriage invoice/);
  no.pos2[0].line_items[0].quantity_billed = 12; // Books now shows the goods as billed
  no.books.state.docs.push({ document_id: 'co', file_name: 'carriage-only.pdf', transactions: [] });
  const c = await runAutoscan({ config: cfg(P2), books: no.books.api, extractor: p2Extractor({ co: { po_reference: 'PO-00090', lines: [], carriage: 12 } }), store: store2, mailer: mailer(), logger });
  assert.equal(c.results[0].status, STATUS.BILLED, c.results[0].reason_text);
  assert.deepEqual(no.books.state.created[1].payload.line_items.map((l) => [l.purchaseorder_item_id, l.quantity, l.rate]), [['c', 1, 12]]);
  assert.equal(no.books.state.created[1].total, 14.4); assert.match(c.results[0].note, /carriage-only invoice/);
});
test('phase 2: an item without a supplier code is billed by value and the note names the code to add; a surcharge the PO price does not contain goes to review', async () => {
  const pos2 = [{ purchaseorder_id: 'po10', purchaseorder_number: 'PO-00100', vendor_id: 'v1', vendor_name: 'Vendor', total: 0, payment_terms: 30, line_items: [poLine('n', null, 22, 5.8, { name: 'Anti-Slip GRP Stair Nosing: White' })] }];
  const books = fakeBooks({ docs: [{ document_id: 'vm', file_name: 'nosing.pdf', transactions: [] }], pos: pos2 }); books.state.contacts.v1 = vendorCf('Zero', 0); books.state.taxOnBills = true;
  books.state.items['it-n'] = { item_id: 'it-n', sku: 'INT-900101', part_number: '' }; // internal SKU only
  const store = new JsonFileStore();
  const r = await runAutoscan({ config: cfg(P2), books: books.api, extractor: p2Extractor({ vm: { po_reference: 'PO-00100', lines: [{ mpn: 'SN1200WH', description: 'Anti-Slip GRP Stair Nosing 55mm White', quantity: 22, unit_price: 5.8 }] } }), store, mailer: mailer(), logger });
  assert.equal(r.results[0].status, STATUS.BILLED, r.results[0].reason_text);
  assert.deepEqual(books.state.created[0].payload.line_items.map((l) => [l.purchaseorder_item_id, l.quantity, l.rate]), [['n', 22, 5.8]]);
  assert.match((await store.getByDocumentIds(['vm'])).get('vm').reason_text, /matched by value \(22 × 5\.80\); add Supplier Reference SN1200WH to the item/);
  // surcharge on top of the PO price
  const pos3 = [{ purchaseorder_id: 'po11', purchaseorder_number: 'PO-00110', vendor_id: 'v1', vendor_name: 'Vendor', total: 0, payment_terms: 30, line_items: [poLine('t', 'LT204', 6, 5.5), poLine('c', null, 1, 14.95, { name: 'Carriage', item_id: 'it-carr' })] }];
  const books2 = fakeBooks({ docs: [{ document_id: 'sx', file_name: 'surcharge.pdf', transactions: [] }], pos: pos3 }); books2.state.contacts.v1 = vendorCf('Zero', 0); books2.state.taxOnBills = true;
  const ex = p2Extractor({ sx: { po_reference: 'PO-00110', lines: [{ mpn: 'LT204', quantity: 6, unit_price: 5.5 }], carriage: 16.6 } });
  const inner = ex.extract.bind(ex);
  ex.extract = async (buffer) => { const out = await inner(buffer); out.extraction.charges = [{ description: 'SUR02 PRODUCT GROUP 5% SURCHARGE', amount: 1.65 }, { description: 'Carriage Net', amount: 14.95 }]; return out; };
  const s = await runAutoscan({ config: cfg(P2), books: books2.api, extractor: ex, store: new JsonFileStore(), mailer: mailer(), logger });
  assert.equal(s.results[0].reason_code, 'PRICE_MISMATCH'); assert.match(s.results[0].reason_text, /LT204: unit price 5\.7750 incl\. the 5\.0% surcharge vs PO 5\.50 \(\+5\.0%/); assert.equal(books2.state.created.length, 0);
});

test('SCAN_SINCE: inbox documents created before the date are never read, recorded or deleted; later ones are processed; unparsable times are skipped', async () => {
  const docs = [
    { document_id: 'old1', file_name: 'old-2024.pdf', transactions: [], created_time: '2024-03-02T09:00:00+0000' },
    { document_id: 'edge', file_name: 'edge.pdf', transactions: [], created_time: '2026-11-16T23:59:59+0000' },
    { document_id: 'd1', file_name: 'a.pdf', transactions: [], created_time: '2026-11-17T08:00:00+0000' },
    { document_id: 'odd', file_name: 'odd.pdf', transactions: [], created_time: 'yesterday' },
  ];
  const books = fakeBooks({ docs, pos });
  const ex = fakeExtractor({ d1: { po_reference: 'PO-00001', gross: 120 }, old1: { po_reference: 'PO-00001', gross: 120 }, edge: { po_reference: 'PO-00001', gross: 120 }, odd: { po_reference: 'PO-00001', gross: 120 } });
  const store = new JsonFileStore();
  const r = await runAutoscan({ config: cfg({ DRY_RUN: 'false', SCAN_SINCE: '2026-11-17' }), books: books.api, extractor: ex, store, mailer: mailer(), logger });
  assert.equal(r.billed, 1); assert.deepEqual(books.state.deleted, ['d1']);
  assert.deepEqual(ex.seen, ['d1'], 'old documents are never sent to the AI');
  const st = await store.getByDocumentIds(['old1', 'edge', 'odd', 'd1']);
  assert.deepEqual([...st.keys()], ['d1'], 'only the eligible document is recorded');
  const r2 = await runAutoscan({ config: cfg({ DRY_RUN: 'false' }), books: fakeBooks({ docs: [docs[0]], pos }).api, extractor: fakeExtractor({ old1: { po_reference: 'PO-00001', gross: 120 } }), store: new JsonFileStore(), mailer: mailer(), logger });
  assert.equal(r2.billed, 1, 'without SCAN_SINCE every document is eligible');
});
