#!/usr/bin/env node
'use strict';

/**
 * Seed the Books SANDBOX with vendors, items and purchase orders that cover
 * every matching scenario, then write seed/seed-output.json which
 * scripts/make-test-invoices.js turns into PDF/JPG "supplier invoices".
 *
 *   node scripts/seed-sandbox.js            → create (idempotent by vendor/item name)
 *   node scripts/seed-sandbox.js --plan     → print the plan, touch nothing
 *
 * Refuses to run unless BOOKS_ORG_ID matches SEED_ALLOW_ORG_ID in .env
 * (a guard against seeding production by mistake).
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fn = (p) => require(path.join(__dirname, '..', 'functions', 'autoscan-run', 'src', p));
const { loadConfig } = fn('config');
const { createLogger } = fn('logger');
const { createTokenProvider } = fn('books/oauth');
const { createBooksClient } = fn('books/client');

// ---------------------------------------------------------------- plan
const VENDORS = [
  { key: 'rustoleum', name: 'Northline Coatings Ltd', terms: 30, carriageRule: 'Zero', carriageTolerance: 0 },
  { key: 'crown', name: 'Harbour Paints Trade', terms: 30, carriageRule: 'Fixed', carriageTolerance: 5 },
  { key: 'harlow', name: 'Harlow Supplies', terms: 60, carriageRule: 'Ignore', carriageTolerance: 0 },
  { key: 'dropship', name: 'Dropship Coatings Co', terms: 14, carriageRule: 'Ignore', carriageTolerance: 0 },
];

const ITEMS = [
  { key: 'combi25', name: 'DuraCoat Gloss 2.5L Black', sku: 'RX-4471', mpn: 'RX-4471', rate: 22.5 },
  { key: 'combi1', name: 'DuraCoat Gloss 1L White', sku: 'RX-4402', mpn: 'RX-4402', rate: 11.2 },
  { key: 'primer5', name: 'Trade Primer 5L', sku: 'CP-PR5', mpn: 'CP-PR5', rate: 34.0 },
  { key: 'emul10', name: 'Trade Emulsion 10L Magnolia', sku: 'CP-EM10M', mpn: 'CP-EM10M', rate: 48.75 },
  { key: 'roller', name: 'Roller Sleeve 9in Medium (pack 10)', sku: 'BS-RS9M', mpn: 'BS-RS9M', rate: 15.9 },
  { key: 'tape', name: 'Masking Tape 48mm (box 24)', sku: 'BS-MT48', mpn: 'BS-MT48', rate: 19.8 },
];

// scenario: what the PO looks like, and what invoice(s) the generator should produce for it
const POS = [
  { key: 'exact', vendor: 'rustoleum', number: null, reference: null, lines: [['combi25', 4], ['combi1', 6]], carriage: 10,
    invoices: [{ suffix: 'A', label: 'Exact match', refStyle: 'zoho', lines: 'all', carriage: 10 }] },
  { key: 'legacy', vendor: 'rustoleum', number: null, reference: 'IPO/316037', lines: [['combi25', 10]], carriage: 0,
    invoices: [{ suffix: 'A', label: 'Legacy IPO/ reference', refStyle: 'legacy', lines: 'all', carriage: 0 }] },
  { key: 'embedded', vendor: 'harlow', number: null, reference: 'IPO 317792', lines: [['roller', 20], ['tape', 5]], carriage: 8.5,
    invoices: [{ suffix: 'A', label: 'Legacy ref embedded in text', refStyle: 'embedded', lines: 'all', carriage: 8.5 }] },
  { key: 'mismatch', vendor: 'crown', number: null, reference: null, lines: [['primer5', 3], ['emul10', 2]], carriage: 12,
    invoices: [{ suffix: 'A', label: 'Total mismatch (price +1.50 on a line)', refStyle: 'zoho', lines: 'all', carriage: 12, priceDelta: { primer5: 1.5 } }] },
  { key: 'carriage_zero', vendor: 'rustoleum', number: null, reference: null, lines: [['combi1', 12]], carriage: 10,
    invoices: [{ suffix: 'A', label: 'Carriage differs, vendor rule Zero → exception', refStyle: 'zoho', lines: 'all', carriage: 12.5 }] },
  { key: 'carriage_fixed', vendor: 'crown', number: null, reference: null, lines: [['emul10', 4]], carriage: 12,
    invoices: [{ suffix: 'A', label: 'Carriage +3.00 within Fixed 5.00 tolerance', refStyle: 'zoho', lines: 'all', carriage: 15 }] },
  { key: 'carriage_ignore', vendor: 'harlow', number: null, reference: null, lines: [['tape', 10]], carriage: 6,
    invoices: [{ suffix: 'A', label: 'Carriage differs, vendor rule Ignore', refStyle: 'zoho', lines: 'all', carriage: 9.95 }] },
  { key: 'partial', vendor: 'crown', number: null, reference: null, lines: [['primer5', 10], ['emul10', 6]], carriage: 0,
    invoices: [
      { suffix: 'A', label: 'Partial delivery 1 of 2', refStyle: 'zoho', lines: { primer5: 6, emul10: 0 }, carriage: 0 },
      { suffix: 'B', label: 'Partial delivery 2 of 2 (closing)', refStyle: 'zoho', lines: { primer5: 4, emul10: 6 }, carriage: 0 },
    ] },
  { key: 'overqty', vendor: 'crown', number: null, reference: null, lines: [['emul10', 3]], carriage: 0,
    invoices: [{ suffix: 'A', label: 'Quantity exceeds PO', refStyle: 'zoho', lines: { emul10: 5 }, carriage: 0 }] },
  { key: 'prestashop', vendor: 'dropship', number: null, reference: 'PS-10234', lines: [['combi25', 2]], carriage: 4.99,
    invoices: [{ suffix: 'A', label: 'PrestaShop-style PO, carriage ignored', refStyle: 'zoho', lines: 'all', carriage: 7.5 }] },
  { key: 'duplicate', vendor: 'harlow', number: null, reference: null, lines: [['roller', 5]], carriage: 0,
    invoices: [
      { suffix: 'A', label: 'First copy', refStyle: 'zoho', lines: 'all', carriage: 0 },
      { suffix: 'A-copy', label: 'Same invoice emailed twice → DUPLICATE', refStyle: 'zoho', lines: 'all', carriage: 0, sameInvoiceNumberAs: 'A' },
    ] },
  { key: 'nopo', vendor: 'harlow', number: null, reference: null, lines: [['tape', 2]], carriage: 0,
    invoices: [{ suffix: 'A', label: 'Invoice without any PO reference → NO_PO_REF', refStyle: 'none', lines: 'all', carriage: 0 }] },
];

(async () => {
  const planOnly = process.argv.includes('--plan');
  const config = loadConfig(process.env);
  if (!planOnly) {
    if (!config.books.orgId || config.books.orgId !== process.env.SEED_ALLOW_ORG_ID) {
      console.error('Refusing to seed: BOOKS_ORG_ID must equal SEED_ALLOW_ORG_ID in .env (sandbox guard).');
      process.exit(2);
    }
  }
  console.log(`Seed plan: ${VENDORS.length} vendors, ${ITEMS.length} items, ${POS.length} POs → ${POS.reduce((s, p) => s + p.invoices.length, 0)} test invoices`);
  if (planOnly) { for (const p of POS) console.log(`  ${p.key.padEnd(16)} ${p.vendor.padEnd(10)} ref=${p.reference || '-'}  ${p.invoices.map((i) => i.label).join(' | ')}`); return; }

  const logger = createLogger({ level: 'warn' });
  const books = createBooksClient({ config: config.books, tokenProvider: createTokenProvider(config.books), logger });
  const out = { org_id: config.books.orgId, created_at: new Date().toISOString(), vendors: {}, items: {}, pos: {} };

  // vendors
  for (const v of VENDORS) {
    const existing = (await books.request('/contacts', { query: { contact_name: v.name, contact_type: 'vendor' } })).contacts || [];
    let c = existing.find((x) => x.contact_name === v.name);
    if (!c) {
      c = (await books.request('/contacts', { method: 'POST', json: { contact_name: v.name, company_name: v.name, contact_type: 'vendor', payment_terms: v.terms, payment_terms_label: `Net ${v.terms}` } })).contact;
      console.log(`+ vendor ${v.name} (${c.contact_id})`);
    } else console.log(`= vendor ${v.name} (${c.contact_id})`);
    out.vendors[v.key] = { contact_id: c.contact_id, name: v.name, terms: v.terms, carriageRule: v.carriageRule, carriageTolerance: v.carriageTolerance };
  }

  // items
  for (const it of ITEMS) {
    const existing = (await books.request('/items', { query: { name: it.name } })).items || [];
    let i = existing.find((x) => x.name === it.name);
    if (!i) {
      i = (await books.request('/items', { method: 'POST', json: { name: it.name, sku: it.sku, rate: it.rate, purchase_rate: it.rate, product_type: 'goods', item_type: 'sales_and_purchases', purchase_description: it.name } })).item;
      console.log(`+ item ${it.name} (${i.item_id})`);
    } else console.log(`= item ${it.name} (${i.item_id})`);
    out.items[it.key] = { item_id: i.item_id, name: it.name, sku: it.sku, mpn: it.mpn, rate: it.rate };
  }

  // purchase orders
  const today = new Date().toISOString().slice(0, 10);
  for (const p of POS) {
    const vendor = out.vendors[p.vendor];
    const tag = `[seed:${p.key}]`;
    const existing = (await books.request('/purchaseorders', { query: { vendor_id: vendor.contact_id } })).purchaseorders || [];
    let po = existing.find((x) => (x.notes || '').includes(tag) || (x.reference_number || '') === tag);
    if (!po) {
      const line_items = p.lines.map(([k, q]) => ({ item_id: out.items[k].item_id, quantity: q, rate: out.items[k].rate }));
      const body = { vendor_id: vendor.contact_id, date: today, reference_number: p.reference || undefined, line_items, notes: `AutoScan test PO ${tag}` };
      if (p.carriage) body.shipping_charge = p.carriage;
      try {
        po = (await books.request('/purchaseorders', { method: 'POST', json: body })).purchaseorder;
      } catch (err) {
        if (p.carriage && /shipping/i.test(err.message)) {
          delete body.shipping_charge;
          body.line_items.push({ name: 'Carriage', description: 'Delivery charge', rate: p.carriage, quantity: 1 });
          po = (await books.request('/purchaseorders', { method: 'POST', json: body })).purchaseorder;
          console.log('  (shipping_charge not accepted on PO — carriage added as a line item)');
        } else throw err;
      }
      console.log(`+ PO ${po.purchaseorder_number} ${p.key} ref=${p.reference || '-'} total=${po.total}`);
    } else console.log(`= PO ${po.purchaseorder_number} ${p.key}`);
    out.pos[p.key] = {
      purchaseorder_id: po.purchaseorder_id, number: po.purchaseorder_number, reference: p.reference, vendor: p.vendor,
      total: po.total, sub_total: po.sub_total, tax_total: po.tax_total, shipping_charge: po.shipping_charge,
      lines: p.lines.map(([k, q]) => ({ item: k, mpn: out.items[k].mpn, name: out.items[k].name, qty: q, rate: out.items[k].rate })),
      carriage: p.carriage, invoices: p.invoices,
    };
  }

  const dir = path.join(__dirname, '..', 'seed');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'seed-output.json'), JSON.stringify(out, null, 2));
  console.log(`\nWrote seed/seed-output.json — next: node scripts/make-test-invoices.js\nBooks calls used: ${books.stats.calls}`);
  console.log('\nManual step (UI, once): Vendor custom fields "Carriage Rule" (dropdown Zero/Fixed/Ignore) and "Carriage Tolerance" (decimal), then set per vendor as in seed-output.json.');
})().catch((err) => { console.error(err.message); process.exit(1); });
