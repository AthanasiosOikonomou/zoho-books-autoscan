#!/usr/bin/env node
'use strict';

/**
 * Rebuild, in the SANDBOX, the purchase orders behind a folder of real supplier documents, so the pipeline
 * can be run against them end to end (documents uploaded to the sandbox inbox afterwards).
 *
 *   node scripts/replicate.js pull --org <organization_id> [--dir golden/edge-2]
 *       READ-ONLY on <organization_id> — GET requests only, enforced at the transport. For every PO reference
 *       read by scripts/golden.js (<dir>/_results/summary.json; <dir>/_source/refs.json overrides / fills gaps)
 *       the PO is resolved exactly like the pipeline does, then PO + vendor + items + linked bills + taxes are
 *       saved to <dir>/_source/snapshot.json, with a readable <dir>/_source/summary.md.
 *
 *   node scripts/replicate.js check [--dir …] [--carriage-rule Zero|Fixed|Ignore] [--carriage-tolerance n]
 *       OFFLINE (no network). Runs the pipeline's own line matcher over the extractions in <dir>/_results and the
 *       POs in the snapshot: what each document would do today. --carriage-rule replaces the vendors' own rule.
 *
 *   node scripts/replicate.js push [--dir …] [--carriage-rule Zero|Fixed|Ignore] [--carriage-tolerance n] [--plan]
 *       Creates the snapshot's vendors, items and purchase orders in the SANDBOX (BOOKS_ORG_ID must equal
 *       SEED_ALLOW_ORG_ID and differ from the snapshot's source): same PO numbers, dates, lines, prices, tax rate,
 *       terms; items keep their SKU and Supplier Reference; vendors get their carriage rule (or --carriage-rule).
 *       Idempotent: vendors by name, items by SKU/name, POs by number. Then upload the documents to the inbox.
 *
 *   node scripts/replicate.js verify [--dir …]
 *       READ-ONLY on the sandbox, after the job has run: per document the bill (total vs invoice, date, due date,
 *       PO link, lines, attachment), the PO's billed status and whether the file is still in the inbox
 *       → <dir>/_source/verify.md.
 *
 * Everything is written under <dir>, which must be git-ignored (./golden is): the snapshot is real business data.
 * Personal data is left out on purpose (addresses, contact persons, bank details are never copied).
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fn = (p) => require(path.join(__dirname, '..', 'functions', 'autoscan-run', 'src', p));
const { loadConfig } = fn('config');
const { createLogger } = fn('logger');
const { createTokenProvider } = fn('books/oauth');
const { createBooksClient } = fn('books/client');
const { resolvePurchaseOrder } = fn('pipeline/resolvePo');
const { vendorCarriageRule } = fn('pipeline/vendorRules');
const { poLineKeys, isCarriageLine, remainingQty, matchLines } = fn('pipeline/lines');
const { matchTotals } = fn('pipeline/match');
const { customFieldDefs, customFieldValues } = require('./lib/custom-fields');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const pick = (o, keys) => { const out = {}; for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k]; return out; };
const customFields = (list) => (list || []).map((f) => pick(f, ['customfield_id', 'field_id', 'label', 'api_name', 'placeholder', 'data_type', 'value', 'value_formatted']));
const flatCf = (o) => { const out = {}; for (const k of Object.keys(o || {})) if (/^cf_/.test(k)) out[k] = o[k]; return out; };

/** A fetch that can only read: anything but GET is refused before it leaves the machine. */
function readOnlyFetch(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  if (method !== 'GET') throw new Error(`read-only source: refused ${method} ${new URL(url).pathname}`);
  return fetch(url, init);
}

/** The documents to look up: what the extractor read, with the manual refs.json on top. */
function readDocs(dir) {
  const byFile = new Map();
  const sumPath = path.join(dir, '_results', 'summary.json');
  if (fs.existsSync(sumPath)) {
    for (const r of JSON.parse(fs.readFileSync(sumPath, 'utf8'))) {
      if (r.error) { byFile.set(r.file, { file: r.file, po_reference: null, invoice_numbers: [], supplier: null, read_by: null, extractor_error: r.error }); continue; }
      byFile.set(r.file, { file: r.file, po_reference: r.po_reference || null, invoice_numbers: r.invoice_number ? [String(r.invoice_number)] : [], supplier: r.supplier || null, read_by: 'extractor', extractor_po_reference: r.po_reference || null });
    }
  }
  const refsPath = path.join(dir, '_source', 'refs.json');
  if (fs.existsSync(refsPath)) {
    for (const [file, v] of Object.entries(JSON.parse(fs.readFileSync(refsPath, 'utf8')))) {
      const cur = byFile.get(file) || { file, po_reference: null, invoice_numbers: [], supplier: null, read_by: null };
      if (v.po_reference && v.po_reference !== cur.po_reference) { cur.po_reference = v.po_reference; cur.read_by = 'refs.json'; }
      for (const n of v.invoice_numbers || []) if (!cur.invoice_numbers.includes(String(n))) cur.invoice_numbers.push(String(n));
      if (v.supplier && !cur.supplier) cur.supplier = v.supplier;
      byFile.set(file, cur);
    }
  }
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

const PO_KEYS = ['purchaseorder_id', 'purchaseorder_number', 'reference_number', 'date', 'delivery_date', 'expected_delivery_date', 'status', 'order_status', 'billed_status', 'received_status', 'current_sub_status',
  'vendor_id', 'vendor_name', 'currency_code', 'currency_id', 'exchange_rate', 'is_inclusive_tax', 'payment_terms', 'payment_terms_label', 'sub_total', 'tax_total', 'total', 'adjustment', 'adjustment_description',
  'discount', 'discount_amount', 'is_discount_before_tax', 'discount_type', 'is_drop_shipment', 'is_backorder', 'template_name', 'created_time', 'last_modified_time'];
const PO_LINE_KEYS = ['line_item_id', 'item_id', 'name', 'description', 'sku', 'item_code', 'item_order', 'quantity', 'quantity_billed', 'quantity_received', 'quantity_cancelled', 'rate', 'bcy_rate', 'unit', 'discount',
  'tax_id', 'tax_name', 'tax_type', 'tax_percentage', 'item_total', 'account_id', 'account_name', 'product_type', 'item_type', 'salesorder_item_id'];
const ITEM_KEYS = ['item_id', 'name', 'sku', 'mpn', 'part_number', 'upc', 'ean', 'isbn', 'unit', 'status', 'product_type', 'item_type', 'rate', 'purchase_rate', 'description', 'purchase_description',
  'account_id', 'account_name', 'purchase_account_id', 'purchase_account_name', 'inventory_account_id', 'inventory_account_name', 'tax_id', 'tax_name', 'tax_percentage', 'purchase_tax_id', 'purchase_tax_name',
  'purchase_tax_percentage', 'vendor_id', 'vendor_name', 'is_taxable', 'track_inventory'];
const BILL_KEYS = ['bill_id', 'bill_number', 'date', 'due_date', 'status', 'reference_number', 'sub_total', 'tax_total', 'total', 'balance', 'adjustment', 'adjustment_description', 'payment_terms', 'payment_terms_label', 'created_time', 'created_by_name', 'source', 'entity_type'];
const BILL_LINE_KEYS = ['line_item_id', 'purchaseorder_item_id', 'item_id', 'name', 'description', 'quantity', 'rate', 'item_total', 'account_id', 'account_name', 'tax_id', 'tax_percentage'];

async function pull() {
  const orgId = opt('--org');
  const dir = path.resolve(ROOT, opt('--dir') || 'golden/edge-2');
  if (!orgId) { console.error('pull needs --org <organization_id> (the organization to read from, read-only)'); process.exit(2); }
  const docs = readDocs(dir);
  if (!docs.length) { console.error(`Nothing to look up: run "node scripts/golden.js --dir ${path.relative(ROOT, dir)}" first (or add _source/refs.json).`); process.exit(2); }
  const srcDir = path.join(dir, '_source');
  fs.mkdirSync(srcDir, { recursive: true });

  const config = loadConfig(process.env);
  const books = createBooksClient({ config: { ...config.books, orgId: String(orgId) }, tokenProvider: createTokenProvider(config.books), logger: createLogger({ level: 'warn' }), fetchImpl: readOnlyFetch });
  const org = (await books.listOrganizations()).find((o) => String(o.organization_id) === String(orgId));
  if (!org) { console.error(`Organization ${orgId} is not visible to this token.`); process.exit(2); }
  console.log(`Source (READ-ONLY): ${org.organization_id} ${org.name}\n${docs.length} document(s) from ${path.relative(ROOT, dir)}\n`);
  // the source org's own PO numbering, when the production profile defines one
  const matching = { ...config.matching, poPrefix: process.env.PROD_PO_PREFIX || config.matching.poPrefix, poPadWidth: Number(process.env.PROD_PO_PAD_WIDTH) || config.matching.poPadWidth };
  const ruleOpts = { ruleLabel: matching.carriageRuleLabel, toleranceLabel: matching.carriageToleranceLabel, defaultRule: matching.defaultCarriageRule };

  const snap = { source_org_id: String(orgId), pulled_at: new Date().toISOString(), taxes: [], payment_terms: [], documents: [], purchase_orders: {}, vendors: {}, items: {}, bills: {} };
  try { snap.taxes = ((await books.request('/settings/taxes')).taxes || []).map((t) => pick(t, ['tax_id', 'tax_name', 'tax_percentage', 'tax_type', 'tax_specific_type', 'is_default_tax'])); } catch (err) { snap.taxes_error = err.message; }
  try { snap.payment_terms = (await books.getPaymentTerms()).map((t) => pick(t, ['payment_terms_id', 'payment_terms', 'payment_terms_label', 'is_default'])); } catch (err) { snap.payment_terms_error = err.message; }

  for (const d of docs) {
    const row = { ...d, po_id: null, po_number: null, strategy: null, tried: [], invoice_already_billed: [] };
    snap.documents.push(row);
    if (!d.po_reference) { row.error = d.extractor_error ? `extractor: ${d.extractor_error}` : 'no PO reference read'; console.log(`✗ ${d.file}: ${row.error}`); continue; }
    try {
      const { po: hit, strategy, tried } = await resolvePurchaseOrder(books, d.po_reference, matching);
      row.tried = tried.map((t) => `${t.field}=${t.value}`);
      if (!hit) { row.error = 'PO not found'; console.log(`✗ ${d.file}: "${d.po_reference}" not found (${row.tried.length} lookups)`); continue; }
      Object.assign(row, { po_id: hit.purchaseorder_id, po_number: hit.purchaseorder_number, strategy });

      if (!snap.purchase_orders[hit.purchaseorder_id]) {
        const po = await books.getPurchaseOrder(hit.purchaseorder_id);
        const lines = (po.line_items || []).map((l) => ({ ...pick(l, PO_LINE_KEYS), item_custom_fields: customFields(l.item_custom_fields), _keys: Object.keys(l) }));
        snap.purchase_orders[po.purchaseorder_id] = {
          ...pick(po, PO_KEYS), custom_fields: customFields(po.custom_fields), line_items: lines, taxes: po.taxes || [],
          bills: (po.bills || []).map((b) => pick(b, BILL_KEYS)), _keys: Object.keys(po),
        };
        if (!snap.vendors[po.vendor_id]) {
          const c = await books.getContact(po.vendor_id);
          snap.vendors[po.vendor_id] = {
            ...pick(c, ['contact_id', 'contact_name', 'company_name', 'contact_type', 'status', 'payment_terms', 'payment_terms_label', 'currency_code', 'currency_id', 'tax_id', 'tax_name', 'vat_treatment']),
            custom_fields: customFields(c.custom_fields), cf: flatCf(c), carriage_rule: vendorCarriageRule(c, ruleOpts),
          };
        }
        for (const l of po.line_items || []) {
          if (!l.item_id || snap.items[l.item_id]) continue;
          try {
            const it = await books.getItem(l.item_id);
            snap.items[l.item_id] = { ...pick(it, ITEM_KEYS), custom_fields: customFields(it.custom_fields), cf: flatCf(it), _keys: Object.keys(it) };
          } catch (err) { snap.items[l.item_id] = { item_id: l.item_id, error: err.message }; }
        }
        // bills already raised against this PO (what has been billed, per PO line)
        let linked = [];
        try { linked = await books.searchBills({ purchaseorder_id: po.purchaseorder_id }); } catch (err) { snap.purchase_orders[po.purchaseorder_id].bills_error = err.message; }
        const ids = [...new Set([...linked.map((b) => b.bill_id), ...(po.bills || []).map((b) => b.bill_id)].filter(Boolean))];
        snap.purchase_orders[po.purchaseorder_id].bill_ids = ids;
        for (const id of ids) {
          if (snap.bills[id]) continue;
          try {
            const b = await books.getBill(id);
            snap.bills[id] = { ...pick(b, BILL_KEYS), vendor_id: b.vendor_id, purchaseorder_ids: b.purchaseorder_ids || (b.purchaseorders || []).map((p) => p.purchaseorder_id), line_items: (b.line_items || []).map((l) => pick(l, BILL_LINE_KEYS)), attachments: (b.documents || []).length };
          } catch (err) { snap.bills[id] = { bill_id: id, error: err.message }; }
        }
      }
      // is this very invoice already a bill in the source organization?
      const po = snap.purchase_orders[hit.purchaseorder_id];
      for (const n of d.invoice_numbers) {
        const hits = await books.searchBills({ vendor_id: po.vendor_id, bill_number: n });
        for (const b of hits.filter((x) => String(x.bill_number).toLowerCase() === String(n).toLowerCase())) row.invoice_already_billed.push(pick(b, BILL_KEYS));
      }
      console.log(`✓ ${d.file}: ${d.po_reference} → ${po.purchaseorder_number} ${po.vendor_name} total=${po.total} status=${po.status}/${po.billed_status || '-'}${row.invoice_already_billed.length ? `  [already billed: ${row.invoice_already_billed.map((b) => b.bill_number).join(', ')}]` : ''}`);
    } catch (err) { row.error = err.message; console.log(`✗ ${d.file}: ${err.message}`); }
  }

  fs.writeFileSync(path.join(srcDir, 'snapshot.json'), JSON.stringify(snap, null, 2));
  fs.writeFileSync(path.join(srcDir, 'summary.md'), summaryMd(snap, matching));
  console.log(`\nBooks calls (all GET): ${books.stats.calls}\n→ ${path.relative(ROOT, path.join(srcDir, 'snapshot.json'))}\n→ ${path.relative(ROOT, path.join(srcDir, 'summary.md'))}`);
}

function summaryMd(snap, matching) {
  const md = [`# Source snapshot — organization ${snap.source_org_id} — ${snap.pulled_at.slice(0, 16)}Z`, ''];
  md.push('| File | PO ref | PO | Vendor | PO status | PO total | Carriage rule | Invoice already billed there |', '|---|---|---|---|---|---|---|---|');
  for (const d of snap.documents) {
    const po = d.po_id ? snap.purchase_orders[d.po_id] : null;
    const v = po ? snap.vendors[po.vendor_id] : null;
    md.push(`| ${d.file} | ${d.po_reference || ''}${d.read_by === 'refs.json' ? ' (manual)' : ''} | ${po ? po.purchaseorder_number : `**${d.error}**`} | ${po ? po.vendor_name : ''} | ${po ? `${po.status}/${po.billed_status || '-'}` : ''} | ${po ? po.total : ''} | ${v ? `${v.carriage_rule.rule}${v.carriage_rule.rule === 'Fixed' ? ` ±${v.carriage_rule.tolerance}` : ''} (${v.carriage_rule.source})` : ''} | ${(d.invoice_already_billed || []).map((b) => `${b.bill_number} ${b.date} ${b.total} ${b.status}`).join('; ')} |`);
  }
  for (const po of Object.values(snap.purchase_orders)) {
    md.push('', `## ${po.purchaseorder_number} — ${po.vendor_name} — ${po.date} — ${po.status}/${po.billed_status || '-'} — sub ${po.sub_total} + tax ${po.tax_total} = ${po.total}${po.adjustment ? ` (adjustment ${po.adjustment})` : ''}`, '');
    md.push(`reference="${po.reference_number || ''}" · terms ${po.payment_terms_label || po.payment_terms} · inclusive_tax=${po.is_inclusive_tax} · custom: ${po.custom_fields.map((f) => `${f.label}=${f.value}`).join(', ') || '-'}`, '');
    md.push('| # | Line | Qty | Billed | Remaining | Rate | Tax | Account | Carriage? | Match keys (Supplier Reference / MPN / SKU) |', '|---|---|---|---|---|---|---|---|---|---|');
    po.line_items.forEach((l, i) => {
      const item = snap.items[l.item_id] || null;
      const keys = poLineKeys(l, item && !item.error ? item : null, { supplierRefLabel: matching.supplierRefLabel });
      md.push(`| ${i + 1} | ${String(l.name || '').replace(/\|/g, '/')}${l.description && l.description !== l.name ? ` — ${String(l.description).replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 80)}` : ''} | ${l.quantity} | ${l.quantity_billed || 0} | ${remainingQty(l)} | ${l.rate} | ${l.tax_percentage ?? ''}% ${l.tax_name || ''} | ${l.account_name || l.account_id || ''} | ${isCarriageLine(l, null) ? 'yes' : ''} | ${keys.map((k) => `\`${k.raw}\` (${k.source})`).join(', ') || '_none_'} |`);
    });
    const bills = (po.bill_ids || []).map((id) => snap.bills[id]).filter(Boolean);
    if (bills.length) {
      md.push('', 'Bills on this PO:');
      for (const b of bills) md.push(`- ${b.bill_number} · ${b.date} · ${b.status} · total ${b.total}${b.adjustment ? ` (adj ${b.adjustment})` : ''} · ${b.attachments || 0} attachment(s) · lines: ${(b.line_items || []).map((l) => `${l.quantity} × ${String(l.name || '').slice(0, 30)} @ ${l.rate}`).join('; ')}`);
    } else md.push('', 'Bills on this PO: none');
  }
  md.push('', `Taxes: ${snap.taxes.map((t) => `${t.tax_name} ${t.tax_percentage}%`).join(', ')}`, `Payment terms: ${snap.payment_terms.map((t) => t.payment_terms_label).join(', ')}`, '');
  return md.join('\n');
}

const RULES = ['Zero', 'Fixed', 'Ignore'];
function ruleOverride() {
  const rule = opt('--carriage-rule');
  if (!rule) return null;
  if (!RULES.includes(rule)) { console.error(`--carriage-rule must be one of ${RULES.join(' | ')}`); process.exit(2); }
  return { rule, tolerance: Number(opt('--carriage-tolerance') || 0), source: 'override' };
}
function readSnapshot(dir) {
  const p = path.join(dir, '_source', 'snapshot.json');
  if (!fs.existsSync(p)) { console.error(`No snapshot in ${path.relative(ROOT, dir)}: run "node scripts/replicate.js pull --org <organization_id>" first.`); process.exit(2); }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function readExtraction(dir, file) {
  const p = path.join(dir, '_results', `${file}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).extraction : null;
}
const money = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : String(n));

// ---------------------------------------------------------------- check (offline)
function check() {
  const dir = path.resolve(ROOT, opt('--dir') || 'golden/edge-2');
  const snap = readSnapshot(dir);
  const matching = { ...loadConfig(process.env).matching, carriageItemId: '' }; // the snapshot's POs carry the source's own carriage items (recognised by name)
  const override = ruleOverride();
  const items = new Map(Object.entries(snap.items).filter(([, it]) => !it.error));
  console.log(`Offline check — POs as in organization ${snap.source_org_id} (${snap.pulled_at.slice(0, 16)}Z), carriage rule: ${override ? `${override.rule}${override.rule === 'Fixed' ? ` ±${override.tolerance}` : ''} for every vendor` : 'each vendor\'s own'}\n`);
  let bill = 0; let review = 0;
  for (const d of snap.documents) {
    const e = readExtraction(dir, d.file);
    const head = `${d.file.slice(0, 44).padEnd(44)}`;
    if (!e) { console.log(`${head} no extraction (run scripts/golden.js)`); continue; }
    const inv = `inv ${String(e.invoice_number).padEnd(12)} ${money(e.totals.gross).padStart(9)}`;
    if (e.document_type !== 'invoice') { console.log(`${head} ${inv} → ${e.document_type === 'credit_note' ? 'credit note (not checked here)' : 'NOT_AN_INVOICE'}`); continue; }
    if (!e.po_reference) { review++; console.log(`${head} ${inv} → NO_PO_REF`); continue; }
    if (e.confidence < matching.confidenceThreshold) { review++; console.log(`${head} ${inv} → LOW_CONFIDENCE (${e.confidence})`); continue; }
    if (!d.po_id) { review++; console.log(`${head} ${inv} → PO_NOT_FOUND ("${e.po_reference}")`); continue; }
    const po = snap.purchase_orders[d.po_id];
    const vendorRule = override || snap.vendors[po.vendor_id].carriage_rule;
    const m = matchLines({ extraction: e, po, items, vendorRule, config: matching });
    let verdict;
    if (m.fallback) {
      const t = matchTotals({ invoiceGross: e.totals.gross, poTotal: po.total, tolerance: matching.totalTolerance, compareAgainstRemaining: false });
      verdict = t.ok ? `WOULD BILL ${money(e.totals.gross)} on totals (${m.reason.text})` : `TOTAL_MISMATCH (totals fallback: invoice ${money(t.invoiceGross)} vs PO ${money(t.poTotal)})`;
      if (t.ok) bill++; else review++;
    } else if (m.ok) { bill++; verdict = `WOULD BILL ${money(m.expected.gross)}${m.expected.diff ? ` (invoice ${money(m.expected.invoiceGross)}, ${money(m.expected.diff)} to adjustment)` : ''}${m.partial ? ' — partial' : ''}`; }
    else { review++; verdict = m.reason.code; }
    console.log(`${head} ${inv} PO ${String(po.purchaseorder_number).padEnd(9)} ${money(po.total).padStart(9)} [${vendorRule.rule}] → ${verdict}`);
    for (const p of m.problems || []) console.log(`      - ${p.code}: ${p.text}`);
    for (const n of m.notes || []) console.log(`      note: ${n}`);
  }
  console.log(`\n${bill} would bill · ${review} to review`);
}

// ---------------------------------------------------------------- push (sandbox)
async function push() {
  const dir = path.resolve(ROOT, opt('--dir') || 'golden/edge-2');
  const snap = readSnapshot(dir);
  const planOnly = argv.includes('--plan');
  const override = ruleOverride();
  const config = loadConfig(process.env);
  const pos = Object.values(snap.purchase_orders).sort((a, b) => String(a.purchaseorder_number).localeCompare(String(b.purchaseorder_number), undefined, { numeric: true }));
  console.log(`Plan: ${new Set(pos.map((p) => p.vendor_id)).size} vendor(s), ${new Set(pos.flatMap((p) => p.line_items.map((l) => l.item_id))).size} item(s), ${pos.length} purchase order(s)${override ? ` — carriage rule ${override.rule}${override.rule === 'Fixed' ? ` ±${override.tolerance}` : ''} on every vendor` : ''}`);
  for (const p of pos) console.log(`  ${String(p.purchaseorder_number).padEnd(10)} ${String(p.vendor_name).padEnd(32)} ${p.date}  ${p.line_items.length} line(s)  total ${money(p.total)}`);
  if (planOnly) return;
  if (!config.books.orgId || config.books.orgId !== process.env.SEED_ALLOW_ORG_ID) { console.error('\nRefusing to write: BOOKS_ORG_ID must equal SEED_ALLOW_ORG_ID in .env (sandbox guard).'); process.exit(2); }
  if (String(config.books.orgId) === String(snap.source_org_id)) { console.error('\nRefusing to write: the target organization is the snapshot\'s source.'); process.exit(2); }

  const books = createBooksClient({ config: config.books, tokenProvider: createTokenProvider(config.books), logger: createLogger({ level: 'warn' }) });
  const org = (await books.listOrganizations()).find((o) => String(o.organization_id) === String(config.books.orgId)) || {};
  console.log(`\nTarget (sandbox): ${config.books.orgId} ${org.name || ''}`);
  const orgInfo = { id: config.books.orgId, name: org.name || '', sandbox: !!org.is_sandbox_org };
  const vendorDefs = await customFieldDefs(books, 'vendor', orgInfo);
  const itemDefs = await customFieldDefs(books, 'item', orgInfo);
  const m = config.matching;
  const out = { target_org_id: String(config.books.orgId), source_org_id: snap.source_org_id, pushed_at: new Date().toISOString(), vendors: {}, items: {}, pos: {} };

  // lookups in the target
  const taxes = (await books.request('/settings/taxes')).taxes || [];
  async function taxFor(pct) {
    const p = Number(pct);
    if (!Number.isFinite(p)) return null;
    let t = taxes.find((x) => Number(x.tax_percentage) === p && (x.tax_type === 'tax' || !x.tax_type));
    if (!t && p > 0) { t = (await books.request('/settings/taxes', { method: 'POST', json: { tax_name: `VAT ${p}%`, tax_percentage: p, tax_type: 'tax' } })).tax; taxes.push(t); console.log(`+ tax ${t.tax_name} (${t.tax_id})`); }
    return t ? t.tax_id : null;
  }
  const accounts = new Map();
  try { for (const a of (await books.request('/chartofaccounts')).chartofaccounts || []) accounts.set(String(a.account_name).trim().toLowerCase(), a.account_id); } catch (err) { console.log(`! chart of accounts not readable (${err.message}) — lines use the items' default accounts`); }
  const terms = await books.getPaymentTerms();
  const warnedTerms = new Set();
  const termsFor = (label, days) => {
    const src = (snap.payment_terms || []).find((t) => t.payment_terms_label === label); // the source's own definition of that label (e.g. −3 = end of next month)
    const want = src ? Number(src.payment_terms) : Number(days);
    if (label && !terms.some((t) => t.payment_terms_label === label) && !warnedTerms.has(label) && warnedTerms.add(label)) console.log(`! payment terms "${label}" are not defined in this organization (Settings → Preferences → Payment Terms) — sent as ${want} / "${label}" anyway`);
    return Number.isFinite(want) ? { payment_terms: want, payment_terms_label: label || undefined } : {};
  };

  // vendors
  for (const vid of [...new Set(pos.map((p) => p.vendor_id))]) {
    const v = snap.vendors[vid];
    const name = v.contact_name;
    let c = ((await books.request('/contacts', { query: { contact_name: name, contact_type: 'vendor' } })).contacts || []).find((x) => x.contact_name === name);
    if (!c) {
      const body = { contact_name: name, company_name: v.company_name || name, contact_type: 'vendor' };
      try { c = (await books.request('/contacts', { method: 'POST', json: { ...body, ...termsFor(v.payment_terms_label, v.payment_terms) } })).contact; }
      catch (err) { console.log(`! vendor ${name}: ${err.message} — created without payment terms`); c = (await books.request('/contacts', { method: 'POST', json: body })).contact; }
      console.log(`+ vendor ${name} (${c.contact_id})`);
    } else console.log(`= vendor ${name} (${c.contact_id})`);
    const rule = override || (v.carriage_rule && v.carriage_rule.source === 'vendor' ? v.carriage_rule : null);
    if (rule) {
      const full = (await books.request(`/contacts/${c.contact_id}`)).contact || c;
      const cf = customFieldValues(full.custom_fields, { [m.carriageRuleLabel.toLowerCase()]: rule.rule, [m.carriageToleranceLabel.toLowerCase()]: rule.tolerance || 0 }, vendorDefs);
      if (cf.missing.length) console.log(`! vendor custom field(s) not found: ${cf.missing.join(', ')}`);
      if (cf.changes.length) {
        try { await books.request(`/contacts/${c.contact_id}`, { method: 'PUT', json: { custom_fields: cf.changes } }); console.log(`  ~ carriage ${rule.rule}${rule.rule === 'Fixed' ? ` ±${rule.tolerance}` : ''}`); }
        catch (err) { console.log(`! ${name}: could not write the carriage rule (${err.message}) — set it in the UI: ${rule.rule}`); }
      } else console.log(`  = carriage ${rule.rule}${rule.rule === 'Fixed' ? ` ±${rule.tolerance}` : ''}`);
    } else console.log(`  = no carriage rule on the source vendor → left as it is here (unset = ${m.defaultCarriageRule})`);
    out.vendors[vid] = { contact_id: c.contact_id, name, carriage_rule: rule ? rule.rule : null };
  }

  // items (by SKU, then by name)
  const srLabel = m.supplierRefLabel.toLowerCase();
  for (const p of pos) for (const l of p.line_items) {
    if (!l.item_id || out.items[l.item_id]) continue;
    const src = snap.items[l.item_id] && !snap.items[l.item_id].error ? snap.items[l.item_id] : { name: l.name, sku: l.sku, purchase_rate: l.rate, rate: l.rate, product_type: l.product_type, custom_fields: [] };
    const sku = src.sku || l.sku || '';
    let it = sku ? ((await books.request('/items', { query: { sku } })).items || []).find((x) => String(x.sku) === String(sku)) : null;
    if (!it) it = ((await books.request('/items', { query: { name: src.name } })).items || []).find((x) => x.name === src.name);
    if (!it) {
      const body = { name: src.name, sku: sku || undefined, rate: Number(src.rate) || Number(l.rate) || 0, purchase_rate: Number(src.purchase_rate) || Number(l.rate) || 0, product_type: src.product_type === 'service' ? 'service' : 'goods', item_type: 'sales_and_purchases', purchase_description: src.purchase_description || undefined };
      it = (await books.request('/items', { method: 'POST', json: body })).item;
      console.log(`+ item ${sku.padEnd(14)} ${src.name.slice(0, 60)} (${it.item_id})`);
    } else console.log(`= item ${sku.padEnd(14)} ${String(it.name).slice(0, 60)} (${it.item_id})`);
    const ref = ((src.custom_fields || []).find((f) => String(f.label || '').trim().toLowerCase() === srLabel) || {}).value;
    if (ref) {
      const full = (await books.request(`/items/${it.item_id}`)).item || it;
      const cf = customFieldValues(full.custom_fields, { [srLabel]: ref }, itemDefs);
      if (cf.missing.length) console.log(`! item custom field "${m.supplierRefLabel}" not found in this organization`);
      if (cf.changes.length) {
        try { await books.request(`/items/${it.item_id}`, { method: 'PUT', json: { custom_fields: cf.changes } }); console.log(`  ~ ${m.supplierRefLabel} ${ref}`); }
        catch (err) { console.log(`! ${src.name}: could not write ${m.supplierRefLabel} (${err.message})`); }
      }
    } else if (!isCarriageLine(l, null)) console.log(`  ! no ${m.supplierRefLabel} on the source item — left empty here too (the line cannot be matched by code)`);
    out.items[l.item_id] = { item_id: it.item_id, sku, name: src.name, supplier_reference: ref || null };
  }

  // purchase orders (same number; never touched when they already exist)
  for (const p of pos) {
    const number = String(p.purchaseorder_number);
    const hit = (await books.searchPurchaseOrders({ purchaseorder_number: number })).find((x) => String(x.purchaseorder_number) === number);
    let po = hit ? await books.getPurchaseOrder(hit.purchaseorder_id) : null;
    if (po) console.log(`= PO ${number} exists (${po.status}/${po.billed_status || '-'}) total ${money(po.total)} — left as it is`);
    else {
      const line_items = [];
      for (const l of [...p.line_items].sort((a, b) => (a.item_order || 0) - (b.item_order || 0))) {
        const li = { item_id: out.items[l.item_id] ? out.items[l.item_id].item_id : undefined, name: l.name, description: l.description || undefined, quantity: l.quantity, rate: l.rate };
        const tax = await taxFor(l.tax_percentage); if (tax) li.tax_id = tax;
        const acct = accounts.get(String(l.account_name || '').trim().toLowerCase()); if (acct) li.account_id = acct;
        line_items.push(li);
        if (Number(l.quantity_billed) > 0) console.log(`! PO ${number} "${l.name}": ${l.quantity_billed} already billed in the source — NOT reproduced here (create that bill by hand if the test needs it)`);
      }
      const body = { purchaseorder_number: number, vendor_id: out.vendors[p.vendor_id].contact_id, date: p.date, reference_number: p.reference_number || undefined, is_inclusive_tax: !!p.is_inclusive_tax, notes: 'AutoScan test PO [replicated]', line_items, ...termsFor(p.payment_terms_label, p.payment_terms) };
      try {
        po = (await books.request('/purchaseorders', { method: 'POST', query: { ignore_auto_number_generation: true }, json: body })).purchaseorder;
      } catch (err) { console.log(`✗ PO ${number}: ${err.message}`); continue; }
      if (p.status && p.status !== 'draft' && String(po.status).toLowerCase() === 'draft') {
        try { await books.request(`/purchaseorders/${po.purchaseorder_id}/status/open`, { method: 'POST' }); po = await books.getPurchaseOrder(po.purchaseorder_id); }
        catch (err) { console.log(`! PO ${number}: could not mark it open (${err.message}) — open it in the UI`); }
      }
      const same = Math.abs(Number(po.total) - Number(p.total)) < 0.011;
      console.log(`+ PO ${number} ${po.vendor_name} ${po.status} total ${money(po.total)}${same ? '' : `  ! source total ${money(p.total)}`} terms ${po.payment_terms}/"${po.payment_terms_label || ''}"`);
    }
    out.pos[p.purchaseorder_id] = { purchaseorder_id: po.purchaseorder_id, number, total: po.total, status: po.status, vendor_id: po.vendor_id };
  }

  fs.writeFileSync(path.join(dir, '_source', 'push-output.json'), JSON.stringify(out, null, 2));
  const files = snap.documents.map((d) => d.file);
  console.log(`\nBooks calls: ${books.stats.calls}\n→ ${path.relative(ROOT, path.join(dir, '_source', 'push-output.json'))}\n\nNext: upload the ${files.length} document(s) of ${path.relative(ROOT, dir)} to this organization's Documents inbox, run the job, then: node scripts/replicate.js verify`);
}

// ---------------------------------------------------------------- verify (sandbox, read-only)
async function verify() {
  const dir = path.resolve(ROOT, opt('--dir') || 'golden/edge-2');
  const snap = readSnapshot(dir);
  const config = loadConfig(process.env);
  const books = createBooksClient({ config: config.books, tokenProvider: createTokenProvider(config.books), logger: createLogger({ level: 'warn' }), fetchImpl: readOnlyFetch });
  const org = (await books.listOrganizations()).find((o) => String(o.organization_id) === String(config.books.orgId)) || {};
  const inbox = await books.listAllInboxDocuments();
  const md = [`# Verify — organization ${config.books.orgId} ${org.name || ''} — ${new Date().toISOString().slice(0, 16)}Z`, '', `Inbox: ${inbox.length} document(s)`, ''];
  md.push('| File | Invoice | Gross | PO | PO status | Bill | Bill total | = invoice | Date | Due | Terms | Linked to PO | Attachment | Still in inbox |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const details = [];
  for (const d of snap.documents) {
    const e = readExtraction(dir, d.file) || { totals: {} };
    const inInbox = inbox.filter((x) => String(x.file_name || '').toLowerCase() === d.file.toLowerCase()).length;
    const srcPo = d.po_id ? snap.purchase_orders[d.po_id] : null;
    const row = [d.file, e.invoice_number || '', money(e.totals.gross)];
    if (!srcPo) { md.push(`| ${row.join(' | ')} | — (no PO in the source) | | | | | | | | | | ${inInbox || 'no'} |`); continue; }
    const number = String(srcPo.purchaseorder_number);
    const hit = (await books.searchPurchaseOrders({ purchaseorder_number: number })).find((x) => String(x.purchaseorder_number) === number);
    if (!hit) { md.push(`| ${row.join(' | ')} | ${number} **missing here** | | | | | | | | | | ${inInbox || 'no'} |`); continue; }
    const po = await books.getPurchaseOrder(hit.purchaseorder_id);
    const found = e.invoice_number ? (await books.searchBills({ vendor_id: po.vendor_id, bill_number: e.invoice_number })).find((b) => String(b.bill_number).toLowerCase() === String(e.invoice_number).toLowerCase()) : null;
    if (!found) { md.push(`| ${row.join(' | ')} | ${number} | ${po.status}/${po.billed_status || '-'} | none | | | | | | | | ${inInbox || 'no'} |`); continue; }
    const b = await books.getBill(found.bill_id);
    const poIds = [...(b.purchaseorder_ids || []), ...(b.purchaseorders || []).map((x) => x.purchaseorder_id)].map(String);
    const poLineIds = new Set((po.line_items || []).map((l) => String(l.line_item_id)));
    const linked = poIds.includes(String(po.purchaseorder_id)) || (b.line_items || []).some((l) => poLineIds.has(String(l.purchaseorder_item_id)));
    const att = (b.documents || []).length || (b.attachment_name ? 1 : 0);
    const eq = Math.abs(Number(b.total) - Number(e.totals.gross)) < 0.005;
    md.push(`| ${row.join(' | ')} | ${number} | ${po.status}/${po.billed_status || '-'} | ${b.bill_number} (${b.status}) | ${money(b.total)} | ${eq ? 'yes' : `**NO** (${money(Number(b.total) - Number(e.totals.gross))})`} | ${b.date}${b.date === e.invoice_date ? '' : ` **≠ ${e.invoice_date}**`} | ${b.due_date} | ${b.payment_terms}/"${b.payment_terms_label || ''}" | ${linked ? 'yes' : '**NO**'} | ${att || '**none**'} | ${inInbox || 'no'} |`);
    details.push('', `## ${b.bill_number} — ${b.vendor_name} — PO ${number}`, '', `sub ${money(b.sub_total)} + tax ${money(b.tax_total)}${Number(b.adjustment) ? ` + adjustment ${money(b.adjustment)} ("${b.adjustment_description || ''}")` : ''} = ${money(b.total)} · invoice ${money(e.totals.gross)} · PO was ${money(po.total)}`, '');
    for (const l of b.line_items || []) details.push(`- ${l.quantity} × ${String(l.name || l.description || '').slice(0, 70)} @ ${l.rate} = ${money(l.item_total)}${l.purchaseorder_item_id ? '' : '  (not a PO line)'} · ${l.account_name || ''}`);
    details.push('', `PO lines after the bill: ${(po.line_items || []).map((l) => `${String(l.name).slice(0, 28)} ${l.quantity_billed || 0}/${l.quantity}`).join(' · ')}`);
  }
  const outPath = path.join(dir, '_source', 'verify.md');
  fs.writeFileSync(outPath, [...md, ...details, ''].join('\n'));
  console.log([...md, ...details].join('\n'));
  console.log(`\nBooks calls (all GET): ${books.stats.calls}\n→ ${path.relative(ROOT, outPath)}`);
}

(async () => {
  const cmd = argv[0];
  if (cmd === 'pull') return pull();
  if (cmd === 'check') return check();
  if (cmd === 'push') return push();
  if (cmd === 'verify') return verify();
  console.error('Usage: node scripts/replicate.js pull --org <organization_id> | check | push | verify   [--dir golden/edge-2] [--carriage-rule Zero|Fixed|Ignore] [--carriage-tolerance n] [--plan]');
  process.exit(2);
})().catch((err) => { console.error(err.message); process.exit(1); });
