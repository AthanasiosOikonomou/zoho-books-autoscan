#!/usr/bin/env node
'use strict';

/**
 * Seed the Books SANDBOX with vendors, items and purchase orders that cover
 * every matching scenario, then write seed/seed-output.json which
 * scripts/make-test-invoices.js turns into PDF/JPG "supplier invoices".
 *
 *   node scripts/seed-sandbox.js            → create (idempotent by vendor/item name and PO tag)
 *   node scripts/seed-sandbox.js --plan     → print the plan, touch nothing
 *   node scripts/seed-sandbox.js --reset    → rewrite the seeded POs in place (same numbers; vendors/items kept)
 *   node scripts/seed-sandbox.js --prune    → delete duplicate seeded POs (keeps the lowest-numbered one per scenario)
 *
 * Facts this seed encodes (verified on the API):
 *   - Books purchase orders have NO shipping-charge field, only `adjustment`.
 *     Carriage is therefore a line item ("Carriage", service item), which is
 *     also how suppliers print it.
 *   - Every line carries a 20% VAT tax so PO totals are gross, like production.
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
    invoices: [
      { suffix: 'A', label: 'Exact match', refStyle: 'zoho', lines: 'all', carriage: 10 },
      { suffix: 'CN', kind: 'credit_note', label: 'Credit note against invoice A (1 × combi25 returned) → vendor credit applied to that bill', refStyle: 'zoho', lines: { combi25: 1, combi1: 0 }, carriage: 0, againstInvoice: 'A' },
      { suffix: 'CN-copy', kind: 'credit_note', label: 'Same credit note emailed twice → DUPLICATE', refStyle: 'zoho', lines: { combi25: 1, combi1: 0 }, carriage: 0, againstInvoice: 'A', sameInvoiceNumberAs: 'CN' },
    ] },
  { key: 'legacy', vendor: 'rustoleum', number: null, reference: 'IPO/316037', lines: [['combi25', 10]], carriage: 0,
    invoices: [{ suffix: 'A', label: 'Legacy IPO/ reference', refStyle: 'legacy', lines: 'all', carriage: 0 }] },
  { key: 'embedded', vendor: 'harlow', number: null, reference: 'IPO 317792', lines: [['roller', 20], ['tape', 5]], carriage: 8.5,
    invoices: [{ suffix: 'A', label: 'Legacy ref embedded in text', refStyle: 'embedded', lines: 'all', carriage: 8.5 }] },
  { key: 'mismatch', vendor: 'crown', number: null, reference: null, lines: [['primer5', 3], ['emul10', 2]], carriage: 12,
    invoices: [{ suffix: 'A', label: 'Price +4.00 on a line (+11.8%) → any increase goes to review', refStyle: 'zoho', lines: 'all', carriage: 12, priceDelta: { primer5: 4 } }] },
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
      { suffix: 'CN', kind: 'credit_note', label: 'Credit note with PO ref only; PO has two bills → vendor credit on the PO, reported as not linked', refStyle: 'zoho', lines: { primer5: 2, emul10: 0 }, carriage: 0 },
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
  { key: 'terms', vendor: 'harlow', number: null, reference: null, lines: [['roller', 3]], carriage: 0,
    invoices: [{ suffix: 'A', label: 'Exact match; bill must inherit the PO payment terms (Net 60)', refStyle: 'zoho', lines: 'all', carriage: 0 }] },
  { key: 'rounding', vendor: 'rustoleum', number: null, reference: null, lines: [['combi1', 7]], carriage: 0,
    invoices: [{ suffix: 'A', label: 'Unit price +0.05 → invoice 42p over the PO, inside the £1 tolerance → BILLED with the invoice total (Phase 1 adjustment); Phase 2: +0.4% increase → review', refStyle: 'zoho', lines: 'all', carriage: 0, priceDelta: { combi1: 0.05 } }] },
  // --- price policy (client, 6 Nov 2026): up to 5% below the PO price → bill at the invoice price; any increase → review
  { key: 'price_lower', vendor: 'rustoleum', number: null, reference: null, lines: [['emul10', 4]], carriage: 0,
    invoices: [{ suffix: 'A', label: 'Unit price −1.45 (−3.0%) → BILLED at the invoice price, noted in the report', refStyle: 'zoho', lines: 'all', carriage: 0, priceDelta: { emul10: -1.45 } }] },
  { key: 'price_lower_far', vendor: 'rustoleum', number: null, reference: null, lines: [['primer5', 3]], carriage: 0,
    invoices: [{ suffix: 'A', label: 'Unit price −3.40 (−10.0%) → PRICE_MISMATCH (allowed down to −5%)', refStyle: 'zoho', lines: 'all', carriage: 0, priceDelta: { primer5: -3.4 } }] },
  { key: 'price_higher', vendor: 'rustoleum', number: null, reference: null, lines: [['combi1', 5]], carriage: 0,
    invoices: [{ suffix: 'A', label: 'Unit price +0.40 (+3.6%) → PRICE_MISMATCH (increases always go to review)', refStyle: 'zoho', lines: 'all', carriage: 0, priceDelta: { combi1: 0.4 } }] },
];

/**
 * Custom-field definitions per entity. Books omits a custom field from an entity's `custom_fields` while it has no
 * value, so the definitions come from Settings (several endpoint spellings exist across DCs/versions); as a last
 * resort the api_name is derived from the label the way Books does (`cf_<slug>`, sandbox: `cf__sb_<org>_<slug>`).
 */
async function customFieldDefs(books, entity, orgId) {
  const defs = new Map(); // label (lower) → { id, api_name, data_type }
  const add = (f) => { if (f && f.label) defs.set(String(f.label).trim().toLowerCase(), { id: f.customfield_id || f.field_id || null, api_name: f.api_name || f.placeholder || null, data_type: f.data_type || null }); };
  for (const p of [`/settings/preferences/customfields?entity=${entity}`, `/settings/customfields?entity=${entity}`, `/settings/preferences/${entity}`]) {
    try {
      const json = await books.request(p);
      const list = json.custom_fields || (json.customfields) || (json[entity] && json[entity].custom_fields) || [];
      for (const f of list) add(f);
      if (defs.size) break;
    } catch (_) { /* try the next spelling */ }
  }
  return {
    resolve(label) {
      const l = String(label).trim().toLowerCase();
      if (defs.has(l)) return defs.get(l);
      const slug = l.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const sb = /sandbox/i.test(String(orgId.name || '')) || orgId.sandbox;
      return { id: null, api_name: `cf_${sb ? `_sb_${orgId.id}_` : ''}${slug}`, data_type: null, guessed: true };
    },
  };
}

/** Build the custom_fields update for the labels whose value differs from what the entity carries. */
function customFieldValues(existing, wanted, defs) {
  const changes = []; const missing = []; const guessed = [];
  const list = existing || [];
  for (const [label, value] of Object.entries(wanted)) {
    const onEntity = list.find((x) => String(x.label || '').trim().toLowerCase() === label);
    const def = onEntity ? { id: onEntity.customfield_id || onEntity.field_id, api_name: onEntity.api_name, data_type: onEntity.data_type } : defs.resolve(label);
    if (!def || (!def.id && !def.api_name)) { missing.push(label); continue; }
    const want = value === null || value === undefined ? '' : String(value);
    const have = onEntity && onEntity.value !== null && onEntity.value !== undefined ? String(onEntity.value) : '';
    const isNum = def.data_type === 'decimal' || def.data_type === 'number' || (!def.data_type && want !== '' && !Number.isNaN(Number(want)) && /tolerance/.test(label));
    if (want === have || (isNum && Number(want) === Number(have))) continue;
    const upd = { value: isNum ? Number(want) : want };
    if (def.id) upd.customfield_id = def.id; else upd.api_name = def.api_name;
    if (def.guessed) guessed.push(def.api_name);
    changes.push(upd);
  }
  return { changes, missing, guessed };
}

(async () => {
  const planOnly = process.argv.includes('--plan');
  const reset = process.argv.includes('--reset');
  const prune = process.argv.includes('--prune');
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
  const orgs = await books.listOrganizations().catch(() => []);
  const thisOrg = orgs.find((o) => String(o.organization_id) === String(config.books.orgId)) || {};
  const orgInfo = { id: config.books.orgId, name: thisOrg.name || '', sandbox: !!thisOrg.is_sandbox_org };
  const vendorDefs = await customFieldDefs(books, 'vendor', orgInfo);
  const itemDefs = await customFieldDefs(books, 'item', orgInfo);

  // vendors
  for (const v of VENDORS) {
    const existing = (await books.request('/contacts', { query: { contact_name: v.name, contact_type: 'vendor' } })).contacts || [];
    let c = existing.find((x) => x.contact_name === v.name);
    if (!c) {
      c = (await books.request('/contacts', { method: 'POST', json: { contact_name: v.name, company_name: v.name, contact_type: 'vendor', payment_terms: v.terms, payment_terms_label: `Net ${v.terms}` } })).contact;
      console.log(`+ vendor ${v.name} (${c.contact_id})`);
    } else if (reset) {
      c = (await books.request(`/contacts/${c.contact_id}`, { method: 'PUT', json: { payment_terms: v.terms, payment_terms_label: `Net ${v.terms}` } })).contact;
      console.log(`~ vendor ${v.name} terms Net ${v.terms}`);
    } else console.log(`= vendor ${v.name} (${c.contact_id})`);
    // Phase 2: vendor custom fields "Carriage Rule" / "Carriage Tolerance" (created once in the UI; written here by label)
    const full = (await books.request(`/contacts/${c.contact_id}`)).contact || c;
    const cfUpdates = customFieldValues(full.custom_fields, { 'carriage rule': v.carriageRule, 'carriage tolerance': v.carriageTolerance }, vendorDefs);
    if (cfUpdates.missing.length) console.log(`! vendor custom field(s) not found: ${cfUpdates.missing.join(', ')} — create them in the UI (Settings → Preferences → Vendors → Custom Fields): "Carriage Rule" dropdown Zero/Fixed/Ignore, "Carriage Tolerance" decimal`);
    if (cfUpdates.changes.length) {
      try {
        await books.request(`/contacts/${c.contact_id}`, { method: 'PUT', json: { custom_fields: cfUpdates.changes } });
        console.log(`  ~ ${v.name}: carriage ${v.carriageRule}${v.carriageRule === 'Fixed' ? ` ±${v.carriageTolerance}` : ''}${cfUpdates.guessed.length ? ` (via ${cfUpdates.guessed.join(', ')})` : ''}`);
      } catch (err) { console.log(`! ${v.name}: could not write carriage fields (${err.message}) — set them in the UI: ${v.carriageRule}${v.carriageRule === 'Fixed' ? ` / ${v.carriageTolerance}` : ''}`); }
    }
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
    // Phase 2: item custom field "Supplier Reference" (production prints it on PO lines; mirrored here) = the supplier's code
    const fullItem = (await books.request(`/items/${i.item_id}`)).item || i;
    const cfu = customFieldValues(fullItem.custom_fields, { 'supplier reference': it.mpn }, itemDefs);
    if (cfu.missing.length && it === ITEMS[0]) console.log(`! item custom field "Supplier Reference" not found — create it in the UI (Settings → Preferences → Items → Custom Fields, type Text, show on PDF) and re-run`);
    if (cfu.changes.length) {
      try { await books.request(`/items/${i.item_id}`, { method: 'PUT', json: { custom_fields: cfu.changes } }); console.log(`  ~ ${it.name}: Supplier Reference ${it.mpn}${cfu.guessed.length ? ` (via ${cfu.guessed.join(', ')})` : ''}`); }
      catch (err) { console.log(`! ${it.name}: could not write Supplier Reference (${err.message}) — does the item custom field exist? (Settings → Preferences → Items → Custom Fields, Text, label exactly "Supplier Reference")`); }
    }
    out.items[it.key] = { item_id: i.item_id, name: it.name, sku: it.sku, mpn: it.mpn, rate: it.rate };
  }

  // payment terms must exist in Settings for vendors/POs to carry them (no API to create them)
  const terms = await books.getPaymentTerms();
  const missing = [...new Set(VENDORS.map((v) => v.terms))].filter((d) => !terms.some((t) => Number(t.payment_terms) === d));
  if (missing.length) console.log(`! Payment terms missing in Settings: ${missing.map((d) => `Net ${d}`).join(', ')} — add them in the UI (Settings → Preferences → Payment Terms); POs/bills will show "Due on Receipt" until then.`);
  else console.log(`= payment terms present: ${terms.map((t) => t.payment_terms_label).join(', ')}`);

  // tax: find a 20% tax or create one
  const VAT_PCT = 20;
  let taxes;
  try {
    taxes = (await books.request('/settings/taxes')).taxes || [];
  } catch (err) {
    if (/sales tax|110817/i.test(err.message)) {
      console.error('\nVAT is disabled in this org. In the SANDBOX UI: Settings → Taxes → VAT Settings → mark the business as VAT registered, then re-run.');
      process.exit(2);
    }
    throw err;
  }
  let tax = taxes.find((t) => Number(t.tax_percentage) === VAT_PCT && (t.tax_type === 'tax' || !t.tax_type));
  if (!tax) {
    tax = (await books.request('/settings/taxes', { method: 'POST', json: { tax_name: `VAT ${VAT_PCT}%`, tax_percentage: VAT_PCT, tax_type: 'tax' } })).tax;
    console.log(`+ tax ${tax.tax_name} (${tax.tax_id})`);
  } else console.log(`= tax ${tax.tax_name} ${tax.tax_percentage}% (${tax.tax_id})`);
  out.tax = { tax_id: tax.tax_id, name: tax.tax_name, percentage: VAT_PCT };

  // carriage as a service item (POs have no shipping-charge field)
  {
    const name = 'Carriage';
    const existing = (await books.request('/items', { query: { name } })).items || [];
    let i = existing.find((x) => x.name === name);
    if (!i) {
      i = (await books.request('/items', { method: 'POST', json: { name, rate: 0, purchase_rate: 0, product_type: 'service', item_type: 'sales_and_purchases', purchase_description: 'Delivery / carriage charge' } })).item;
      console.log(`+ item ${name} (${i.item_id})`);
    } else console.log(`= item ${name} (${i.item_id})`);
    out.items.carriage = { item_id: i.item_id, name, sku: null, mpn: null, rate: 0 };
  }

  // purchase orders — existing ones are recognised by vendor + line signature
  // (the list endpoint does not return notes). The LOWEST-numbered match is the
  // canonical PO (that's the number printed on the test PDFs); extras are
  // deleted with --prune.
  const today = new Date().toISOString().slice(0, 10);
  const carriageId = out.items.carriage.item_id;
  const signature = (lines) => lines.filter((l) => l.item_id !== carriageId).map((l) => `${l.item_id}:${Number(l.quantity)}`).sort().join(',');
  const detailCache = new Map(); // vendor contact_id → [po detail]
  async function vendorPoDetails(vendorId) {
    if (!detailCache.has(vendorId)) {
      const list = (await books.request('/purchaseorders', { query: { vendor_id: vendorId } })).purchaseorders || [];
      const details = [];
      for (const x of list) details.push((await books.request(`/purchaseorders/${x.purchaseorder_id}`)).purchaseorder);
      detailCache.set(vendorId, details);
    }
    return detailCache.get(vendorId);
  }

  for (const p of POS) {
    const vendor = out.vendors[p.vendor];
    const tag = `[seed:${p.key}]`;
    const line_items = p.lines.map(([k, q]) => ({ item_id: out.items[k].item_id, quantity: q, rate: out.items[k].rate, tax_id: tax.tax_id }));
    if (p.carriage) line_items.push({ item_id: carriageId, description: 'Delivery charge', quantity: 1, rate: p.carriage, tax_id: tax.tax_id });
    const body = { vendor_id: vendor.contact_id, date: today, reference_number: p.reference || undefined, line_items, is_inclusive_tax: false, payment_terms: vendor.terms, payment_terms_label: `Net ${vendor.terms}`, notes: `AutoScan test PO ${tag}` };

    const wanted = signature(line_items);
    const matches = (await vendorPoDetails(vendor.contact_id))
      .filter((d) => signature(d.line_items || []) === wanted)
      .sort((a, b) => String(a.purchaseorder_number).localeCompare(String(b.purchaseorder_number), undefined, { numeric: true }));
    let po = matches[0] || null;
    const extras = matches.slice(1);

    if (extras.length && prune) {
      for (const e of extras) {
        await books.request(`/purchaseorders/${e.purchaseorder_id}`, { method: 'DELETE' });
        console.log(`- PO ${e.purchaseorder_number} ${p.key} deleted (duplicate of ${po.purchaseorder_number})`);
      }
    } else if (extras.length) {
      console.log(`! ${p.key}: ${extras.length} duplicate PO(s) ${extras.map((e) => e.purchaseorder_number).join(', ')} — run with --prune to delete`);
    }

    if (po && reset && ['billed', 'partially_billed'].includes(String(po.billed_status || '').toLowerCase())) {
      console.log(`= PO ${po.purchaseorder_number} ${p.key} is ${po.billed_status} — left untouched (Books forbids edits)`);
    } else if (po && reset) {
      try {
        po = (await books.request(`/purchaseorders/${po.purchaseorder_id}`, { method: 'PUT', json: body })).purchaseorder;
        console.log(`~ PO ${po.purchaseorder_number} ${p.key} rewritten: sub_total=${po.sub_total} tax=${po.tax_total} total=${po.total}`);
      } catch (err) {
        if (err.booksCode === 36023) console.log(`= PO ${po.purchaseorder_number} ${p.key} is billed — left untouched`);
        else throw err;
      }
    } else if (!po) {
      po = (await books.request('/purchaseorders', { method: 'POST', json: body })).purchaseorder;
      console.log(`+ PO ${po.purchaseorder_number} ${p.key} ref=${p.reference || '-'} sub_total=${po.sub_total} tax=${po.tax_total} total=${po.total}`);
    } else console.log(`= PO ${po.purchaseorder_number} ${p.key} total=${po.total}`);
    out.pos[p.key] = {
      purchaseorder_id: po.purchaseorder_id, number: po.purchaseorder_number, reference: p.reference, vendor: p.vendor,
      total: po.total, sub_total: po.sub_total, tax_total: po.tax_total,
      lines: p.lines.map(([k, q]) => ({ item: k, mpn: out.items[k].mpn, name: out.items[k].name, qty: q, rate: out.items[k].rate })),
      carriage: p.carriage, invoices: p.invoices,
    };
  }

  const dir = path.join(__dirname, '..', 'seed');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'seed-output.json'), JSON.stringify(out, null, 2));
  console.log(`\nWrote seed/seed-output.json — next: node scripts/make-test-invoices.js\nBooks calls used: ${books.stats.calls}`);
  console.log('\nPhase 2 fields written where they exist: vendor "Carriage Rule"/"Carriage Tolerance", item "Supplier Reference" (see any "!" lines above for the ones to create in the UI).');
})().catch((err) => { console.error(err.message); process.exit(1); });
