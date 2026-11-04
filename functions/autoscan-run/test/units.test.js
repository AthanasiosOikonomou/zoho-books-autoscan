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
const { loadConfig, assertRuntimeConfig } = require('../src/config');
const { createSmtpMailer, createMailer } = require('../src/report/mailers');
const { createLogger, describeError, errorMessage } = require('../src/logger');
const { JsonFileStore } = require('../src/state/store');

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

test('smtp mailer: sends through the injected transport with from/to/cc/subject/html/text', async () => {
  const calls = [];
  const transport = { async sendMail(m) { calls.push(m); return { messageId: '<x@y>' }; } };
  const logs = [];
  const logger = { info: (e, d) => logs.push([e, d]), warn: (e) => logs.push([e]) };
  const m = createSmtpMailer({ smtp: { user: 'bot@example.test' }, logger, transport });
  await m.send({ to: ['fin@example.test'], cc: ['dev@example.test'], subject: 'S', html: '<b>h</b>', text: 't', from: '' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].from, 'bot@example.test');
  assert.deepEqual(calls[0].to, ['fin@example.test']);
  assert.deepEqual(calls[0].cc, ['dev@example.test']);
  assert.equal(calls[0].html, '<b>h</b>');
  assert.equal(logs[0][0], 'mail.sent');
});
test('smtp mailer: no recipients → nothing sent', async () => {
  const transport = { async sendMail() { throw new Error('must not be called'); } };
  const m = createSmtpMailer({ smtp: {}, logger: { warn() {}, info() {} }, transport });
  await m.send({ to: [], subject: 'S', html: '' });
});
test('config: MAIL_TRANSPORT=smtp requires SMTP_USER/SMTP_PASS and defaults REPORT_FROM to SMTP_USER', () => {
  const base = { BOOKS_ORG_ID: '1', BOOKS_CLIENT_ID: 'c', BOOKS_CLIENT_SECRET: 's', BOOKS_REFRESH_TOKEN: 'r', ANTHROPIC_API_KEY: 'k' };
  assert.throws(() => assertRuntimeConfig(loadConfig({ ...base, MAIL_TRANSPORT: 'smtp' })), /SMTP_USER, SMTP_PASS/);
  const cfg = assertRuntimeConfig(loadConfig({ ...base, MAIL_TRANSPORT: 'smtp', SMTP_USER: 'bot@example.test', SMTP_PASS: 'p' }));
  assert.equal(cfg.report.from, 'bot@example.test');
  assert.equal(cfg.report.smtp.host, 'smtp.zoho.eu'); assert.equal(cfg.report.smtp.port, 465); assert.equal(cfg.report.smtp.secure, true);
  assert.throws(() => assertRuntimeConfig(loadConfig({ ...base, MAIL_TRANSPORT: 'pigeon' })), /MAIL_TRANSPORT/);
  assert.equal(loadConfig(base).report.transport, 'log');
  assert.doesNotThrow(() => assertRuntimeConfig(loadConfig(base)));
});
test('createMailer: picks smtp vs catalyst by config', () => {
  const logger = { info() {}, warn() {} };
  const smtpCfg = loadConfig({ MAIL_TRANSPORT: 'smtp', SMTP_USER: 'u', SMTP_PASS: 'p' });
  assert.equal(typeof createMailer({ config: smtpCfg, app: null, logger }).send, 'function');
  assert.equal(typeof createMailer({ config: loadConfig({ MAIL_TRANSPORT: 'catalyst' }), app: { email() { return {}; } }, logger }).send, 'function');
});
test('log mailer: sends nothing, writes the text report to stdout', async () => {
  const logs = []; const out = [];
  const orig = console.log; console.log = (s) => out.push(String(s));
  try {
    await createMailer({ config: loadConfig({}), app: null, logger: { info: (e, d) => logs.push([e, d]), warn() {} } })
      .send({ subject: 'AutoScan run', to: ['a@b.c'], html: '<b>x</b>', text: 'TEXT REPORT' });
  } finally { console.log = orig; }
  assert.equal(logs[0][0], 'mail.skipped');
  assert.ok(out.join('\n').includes('TEXT REPORT'));
});

test('logger: every level goes to stdout as one JSON line; errors of any shape are described', () => {
  const out = []; const sink = { log: (l) => out.push(l), warn: () => { throw new Error('stderr must not be used'); }, error: () => { throw new Error('stderr must not be used'); } };
  const log = createLogger({ sink, level: 'info' });
  const e = new Error('boom'); e.code = 'E1'; e.status = 429;
  log.error('x', { error: e }); log.warn('y', { error: { status: 400, data: { message: 'bad column' }, api_key: 'k' } }); log.info('z', { error: 'plain' });
  const [a, b, c] = out.map((l) => JSON.parse(l));
  assert.equal(a.lvl, 'error'); assert.equal(a.error.message, 'boom'); assert.equal(a.error.code, 'E1'); assert.equal(a.error.status, 429);
  assert.equal(b.lvl, 'warn'); assert.equal(b.error.status, 400); assert.ok(b.error.detail.includes('bad column')); assert.ok(!b.error.detail.includes('"k"'));
  assert.equal(c.error.message, 'plain');
  assert.equal(errorMessage(undefined), 'undefined'); assert.equal(errorMessage(new Error('m')), 'm');
  assert.ok(errorMessage({ status: 500, data: { x: 1 } }).includes('"x":1'));
  assert.deepEqual(Object.keys(describeError('s')), ['message']);
});
test('retry window: transient reasons (AI/Books/attach) are retried on the next run, others after RETRY_AFTER_HOURS', async () => {
  const store = new JsonFileStore();
  const t0 = new Date('2026-11-04T10:00:00Z');
  const row = (id, reason_code, status = 'EXCEPTION') => ({ document_id: id, file_name: id, status, reason_code, attempts: 1, last_attempt: t0.toISOString(), first_seen: t0.toISOString() });
  await store.upsert(row('ai', 'AI_ERROR')); await store.upsert(row('books', 'BOOKS_ERROR')); await store.upsert(row('att', 'ATTACH_FAILED', 'BILLED_NO_ATTACH'));
  await store.upsert(row('po', 'PO_NOT_FOUND')); await store.upsert(row('wb', null, 'WOULD_BILL')); await store.upsert(row('dup', 'DUPLICATE', 'DUPLICATE'));
  const at = (min) => new Date(t0.getTime() + min * 60000);
  const ids = (rows) => rows.map((r) => r.document_id).sort();
  // 30 min later: only the transient ones
  assert.deepEqual(ids(await store.listRetryCandidates({ olderThan: at(30 - 12 * 60), transientOlderThan: at(30), maxAttempts: 5, limit: 50 })), ['ai', 'att', 'books']);
  // 13 h later: everything retryable
  assert.deepEqual(ids(await store.listRetryCandidates({ olderThan: at(13 * 60 - 12 * 60), transientOlderThan: at(13 * 60), maxAttempts: 5, limit: 50 })), ['ai', 'att', 'books', 'po', 'wb']);
  // attempts cap still applies to transient ones
  assert.deepEqual(ids(await store.listRetryCandidates({ olderThan: at(30 - 12 * 60), transientOlderThan: at(30), maxAttempts: 1, limit: 50 })), []);
});

test('retry window: a PROCESSING claim older than the lock window (dead run) is retried; a fresh one is not', async () => {
  const store = new JsonFileStore();
  const t0 = new Date('2026-11-04T10:00:00Z');
  await store.upsert({ document_id: 'old', file_name: 'old.pdf', status: 'PROCESSING', attempts: 1, last_attempt: t0.toISOString(), first_seen: t0.toISOString() });
  await store.upsert({ document_id: 'fresh', file_name: 'fresh.pdf', status: 'PROCESSING', attempts: 1, last_attempt: new Date(t0.getTime() + 20 * 60000).toISOString(), first_seen: t0.toISOString() });
  const now = new Date(t0.getTime() + 25 * 60000);
  const args = { olderThan: new Date(now - 12 * 3600000), transientOlderThan: now, staleOlderThan: new Date(now - 15 * 60000), maxAttempts: 5, limit: 50 };
  assert.deepEqual((await store.listRetryCandidates(args)).map((r) => r.document_id), ['old']);
  assert.deepEqual((await store.listRetryCandidates({ ...args, staleOlderThan: undefined })).map((r) => r.document_id), [], 'without a stale window PROCESSING rows are never retried');
});
