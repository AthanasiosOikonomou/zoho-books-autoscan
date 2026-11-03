#!/usr/bin/env node
'use strict';

/**
 * Read-only probe of the Books org in .env: organizations, payment terms,
 * inbox document count, a few POs. Use it right after generating the token
 * to confirm BOOKS_ORG_ID points at the SANDBOX.
 *
 *   node scripts/books-probe.js            → everything below
 *   node scripts/books-probe.js orgs       → just list organizations
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fn = (p) => require(path.join(__dirname, '..', 'functions', 'autoscan-run', 'src', p));
const { loadConfig } = fn('config');
const { createLogger } = fn('logger');
const { createTokenProvider } = fn('books/oauth');
const { createBooksClient } = fn('books/client');

(async () => {
  const what = process.argv[2] || 'all';
  const config = loadConfig(process.env);
  const logger = createLogger({ level: 'warn' });
  const tokenProvider = createTokenProvider(config.books);
  const books = createBooksClient({ config: { ...config.books, orgId: config.books.orgId || '0' }, tokenProvider, logger });

  const orgs = await books.listOrganizations();
  console.log('\nOrganizations visible to this token:');
  for (const o of orgs) console.log(`  ${o.organization_id}  ${o.name}  [${o.is_default_org ? 'default' : ''}${o.is_sandbox_org || /sandbox/i.test(o.name) ? ' SANDBOX?' : ''}]`);
  if (what === 'orgs') return;
  if (!config.books.orgId) { console.log('\nSet BOOKS_ORG_ID in .env and run again.'); return; }

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
