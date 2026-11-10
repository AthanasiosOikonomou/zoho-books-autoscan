#!/usr/bin/env node
'use strict';

/**
 * Read-only probe of the Books org in .env: organizations, payment terms,
 * inbox document count, a few POs. Use it right after generating the token
 * to confirm BOOKS_ORG_ID points at the SANDBOX.
 *
 *   node scripts/books-probe.js            → everything below
 *   node scripts/books-probe.js orgs       → just list organizations
 *   node scripts/books-probe.js po PO-00001 → one PO as the API returns it (line-item keys: sku? mpn? custom fields?)
 *   node scripts/books-probe.js item <item_id> → one item as the API returns it (mpn / sku / custom_fields)
 *   node scripts/books-probe.js vendor <contact_id> → one vendor (custom_fields → carriage rule / tolerance)
 *   node scripts/books-probe.js find "IPO/354120" → how a supplier's PO reference resolves: PO number, then reference_number
 *   node scripts/books-probe.js items carriage → compact list of the items matching a search text (id, name, sku, purchase account)
 *
 * Any command accepts --org <organization_id> to look at ANOTHER org read-only (e.g. production, to check how
 * legacy IPO/ references are stored and which item fields carry the MPN). Nothing here writes.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fn = (p) => require(path.join(__dirname, '..', 'functions', 'autoscan-run', 'src', p));
const { loadConfig } = fn('config');
const { createLogger } = fn('logger');
const { createTokenProvider } = fn('books/oauth');
const { createBooksClient } = fn('books/client');

(async () => {
  const argv = process.argv.slice(2);
  const orgIdx = argv.indexOf('--org');
  const orgOverride = orgIdx >= 0 ? argv.splice(orgIdx, 2)[1] : null;
  const what = argv[0] || 'all';
  const config = loadConfig(process.env);
  if (orgOverride) { config.books.orgId = String(orgOverride); console.log(`(read-only, organization ${orgOverride})`); }
  const logger = createLogger({ level: 'warn' });
  const tokenProvider = createTokenProvider(config.books);
  const books = createBooksClient({ config: { ...config.books, orgId: config.books.orgId || '0' }, tokenProvider, logger });

  const orgs = await books.listOrganizations();
  console.log('\nOrganizations visible to this token:');
  for (const o of orgs) console.log(`  ${o.organization_id}  ${o.name}  [${o.is_default_org ? 'default' : ''}${o.is_sandbox_org || /sandbox/i.test(o.name) ? ' SANDBOX?' : ''}]`);
  if (what === 'orgs') return;
  if (!config.books.orgId) { console.log('\nSet BOOKS_ORG_ID in .env and run again.'); return; }

  // ---- raw-shape probes for Phase 2 (print the keys we have to map; values are the sandbox's own seed data)
  const arg = argv[1];
  if (what === 'raw') {
    // raw GET of any Books path, e.g. raw /settings/paymentterms — prints keys and a trimmed body (no secrets in these endpoints)
    const json = await books.request(arg);
    console.log(`\nGET ${arg} → keys: ${Object.keys(json).join(', ')}`);
    console.log(JSON.stringify(json, null, 1).slice(0, 1500));
    return;
  }
  if (what === 'items') {
    // compact list of items matching a search text — one line each, then a count per purchase account
    const rows = [];
    for (let page = 1; page <= 10; page++) {
      const json = await books.request('/items', { query: { search_text: arg || '', page, per_page: 200 } });
      rows.push(...(json.items || []));
      if (!json.page_context || !json.page_context.has_more_page) break;
    }
    const byAccount = new Map();
    console.log(`\n${rows.length} item(s) matching "${arg || ''}":`);
    for (const it of rows) {
      const acct = it.purchase_account_name ? `${it.purchase_account_name} [${it.purchase_account_id}]` : '(no purchase account)';
      byAccount.set(acct, (byAccount.get(acct) || 0) + 1);
      const extra = Object.keys(it).filter((k) => /^cf_.*(supplier|vendor)/i.test(k) && it[k]).map((k) => `${k}=${it[k]}`).join(' ');
      console.log(`  ${it.item_id}  ${String(it.name || '').padEnd(44).slice(0, 44)}  sku=${String(it.sku || '').padEnd(12)}  ${it.status === 'active' ? '' : `[${it.status}] `}${acct}${it.vendor_name ? `  vendor=${it.vendor_name}` : ''}${extra ? `  ${extra}` : ''}`);
    }
    console.log('\nBy purchase account:');
    for (const [a, n] of [...byAccount.entries()].sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(4)}  ${a}`);
    return;
  }
  if (what === 'find') {
    const { candidatesFor } = fn('pipeline/resolvePo');
    const cands = candidatesFor(arg, config.matching);
    console.log(`\nCandidates for "${arg}": ${cands.join(' | ')}`);
    for (const c of cands.filter((x) => !/\s/.test(x)).slice(0, 8)) {
      const hits = await books.searchPurchaseOrders({ purchaseorder_number: c });
      const exact = hits.find((p) => String(p.purchaseorder_number).toLowerCase() === c.toLowerCase());
      if (exact) { console.log(`  purchaseorder_number = ${c} → ${exact.purchaseorder_number} (${exact.purchaseorder_id}) ${exact.vendor_name} total=${exact.total} status=${exact.status} ref="${exact.reference_number || ''}"`); return; }
    }
    for (const c of cands.slice(0, 8)) {
      const hits = await books.searchPurchaseOrders({ reference_number: c });
      const exact = hits.find((p) => String(p.reference_number || '').toLowerCase() === c.toLowerCase());
      if (exact) { console.log(`  reference_number = ${c} → ${exact.purchaseorder_number} (${exact.purchaseorder_id}) ${exact.vendor_name} total=${exact.total} status=${exact.status}`); return; }
      if (hits.length) console.log(`  reference_number ~ ${c}: ${hits.slice(0, 3).map((p) => `${p.purchaseorder_number} ref="${p.reference_number}"`).join(', ')}`);
    }
    console.log('  → not found by number or reference');
    return;
  }
  if (what === 'po') {
    const hits = await books.searchPurchaseOrders({ purchaseorder_number: arg });
    const hit = hits.find((p) => p.purchaseorder_number === arg) || hits[0];
    if (!hit) { console.log(`\nNo PO ${arg}`); return; }
    const po = await books.getPurchaseOrder(hit.purchaseorder_id);
    console.log(`\nPO ${po.purchaseorder_number} — top-level keys:\n  ${Object.keys(po).join(', ')}`);
    const li = (po.line_items || [])[0] || {};
    console.log(`\nFirst line item — keys:\n  ${Object.keys(li).join(', ')}`);
    console.log(`\nFirst line item — values of interest:\n  ${JSON.stringify({ item_id: li.item_id, name: li.name, sku: li.sku, mpn: li.mpn, description: li.description, quantity: li.quantity, quantity_billed: li.quantity_billed, rate: li.rate, tax_id: li.tax_id, tax_percentage: li.tax_percentage, account_id: li.account_id, item_custom_fields: li.item_custom_fields, custom_fields: li.custom_fields }, null, 1)}`);
    console.log(`\nPO custom_fields: ${JSON.stringify(po.custom_fields || [])}  shipping_charge=${po.shipping_charge}  adjustment=${po.adjustment}`);
    return;
  }
  if (what === 'item') {
    const json = await books.request(`/items/${arg}`);
    const it = json.item || {};
    console.log(`\nItem ${it.item_id} — keys:\n  ${Object.keys(it).join(', ')}`);
    console.log(`\nValues of interest:\n  ${JSON.stringify({ name: it.name, sku: it.sku, mpn: it.mpn, upc: it.upc, ean: it.ean, isbn: it.isbn, part_number: it.part_number, vendor_id: it.vendor_id, purchase_rate: it.purchase_rate, purchase_account_id: it.purchase_account_id, custom_fields: it.custom_fields }, null, 1)}`);
    return;
  }
  if (what === 'vendor') {
    const json = await books.request(`/contacts/${arg}`);
    const c = json.contact || {};
    console.log(`\nVendor ${c.contact_id} ${c.contact_name} — keys:\n  ${Object.keys(c).join(', ')}`);
    console.log(`\ncustom_fields: ${JSON.stringify(c.custom_fields || [], null, 1)}`);
    for (const k of Object.keys(c)) if (k.startsWith('cf_')) console.log(`  ${k} = ${JSON.stringify(c[k])}`);
    return;
  }

  const terms = await books.getPaymentTerms();
  console.log(`\nPayment terms (${terms.length}):`);
  for (const t of terms) console.log(`  ${t.payment_terms}d  "${t.payment_terms_label}"`);

  const { documents, pageContext } = await books.listInboxDocuments({ page: 1, perPage: 10 });
  console.log(`\nInbox documents: page 1 of ${pageContext.has_more_page ? 'many' : '1'} — showing ${documents.length}`);
  for (const d of documents) console.log(`  ${d.document_id}  ${d.file_name}  ${d.created_time || ''}  tx=${(d.transactions || []).length}`);

  const pos = await books.searchPurchaseOrders({ per_page: 10 });
  console.log(`\nPurchase orders (first ${pos.length}):`);
  for (const p of pos) console.log(`  ${p.purchaseorder_id}  ${p.purchaseorder_number}  ref="${p.reference_number || ''}"  ${p.vendor_name}  total=${p.total}  status=${p.status}  billed=${p.billed_status || ''}`);

  console.log(`\nBooks calls used: ${books.stats.calls}`);
})().catch((err) => { console.error(err.message); process.exit(1); });
