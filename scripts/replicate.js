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
const { poLineKeys, isCarriageLine, remainingQty } = fn('pipeline/lines');

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

(async () => {
  const cmd = argv[0];
  if (cmd === 'pull') return pull();
  console.error('Usage: node scripts/replicate.js pull --org <organization_id> [--dir golden/edge-2]');
  process.exit(2);
})().catch((err) => { console.error(err.message); process.exit(1); });
