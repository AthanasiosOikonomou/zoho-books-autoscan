#!/usr/bin/env node
'use strict';

/**
 * Generate synthetic supplier invoices (PDF) for every scenario in
 * seed/seed-output.json, in deliberately different layouts per vendor so the
 * extractor is exercised the way real suppliers do it.
 *
 *   node scripts/make-test-invoices.js            → seed/invoices/*.pdf + manifest.json
 *
 * Upload the PDFs to the sandbox Documents inbox (drag & drop, or email them
 * to the sandbox inbox address), then run scripts/local-run.js.
 * Requires: npm install at the repo root (pdfkit).
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const seedPath = path.join(__dirname, '..', 'seed', 'seed-output.json');
if (!fs.existsSync(seedPath)) { console.error('Run scripts/seed-sandbox.js first.'); process.exit(2); }
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
const outDir = path.join(__dirname, '..', 'seed', 'invoices');
fs.mkdirSync(outDir, { recursive: true });

const VAT = ((seed.tax && seed.tax.percentage) || 20) / 100;
const manifest = [];
let seq = 480000;
let cseq = 490000; // credit notes count separately so adding one never renumbers the invoices already uploaded

for (const [key, po] of Object.entries(seed.pos)) {
  for (const inv of po.invoices) {
    const vendor = seed.vendors[po.vendor];
    const lines = po.lines
      .map((l) => {
        const qty = inv.lines === 'all' ? l.qty : (inv.lines[l.item] ?? 0);
        const rate = l.rate + ((inv.priceDelta && inv.priceDelta[l.item]) || 0);
        return { ...l, qty, rate, total: round2(qty * rate) };
      })
      .filter((l) => l.qty > 0);
    const net = round2(lines.reduce((s, l) => s + l.total, 0));
    const carriage = inv.carriage || 0;
    const vat = round2((net + carriage) * VAT);
    const gross = round2(net + carriage + vat);
    const isCredit = inv.kind === 'credit_note';
    const invoiceNumber = inv.sameInvoiceNumberAs
      ? manifest.find((m) => m.po_key === key && m.suffix === inv.sameInvoiceNumberAs).invoice_number
      : isCredit ? creditNumberFor(po.vendor, ++cseq) : invoiceNumberFor(po.vendor, ++seq);
    const ref = refFor(inv.refStyle, po);
    const againstInvoice = inv.againstInvoice ? (manifest.find((m) => m.po_key === key && m.suffix === inv.againstInvoice) || {}).invoice_number || null : null;
    const file = `${key}-${inv.suffix}.pdf`;
    if (isCredit) renderCreditNote(path.join(outDir, file), { vendor, po, inv, lines, net, carriage, vat, gross, creditNumber: invoiceNumber, ref, againstInvoice });
    else renderInvoice(path.join(outDir, file), { vendor, po, inv, lines, net, carriage, vat, gross, invoiceNumber, ref });
    manifest.push({ file, kind: isCredit ? 'credit_note' : 'invoice', po_key: key, suffix: inv.suffix, label: inv.label, vendor: vendor.name, po_number: po.number, po_reference: po.reference, printed_ref: ref, invoice_number: invoiceNumber, against_invoice: againstInvoice, net, carriage, vat, gross, expected: expectedOutcome(inv, key) });
    const poTotal = Number(po.total || 0);
    const flag = inv.lines === 'all' && !inv.priceDelta && Math.abs(gross - poTotal) <= 0.02 ? 'MATCH' : 'differs';
    console.log(`${file.padEnd(24)} ${invoiceNumber.padEnd(14)} ref="${ref || ''}" gross=${gross.toFixed(2)} PO=${poTotal.toFixed(2)} ${flag.padEnd(7)} ${inv.label}`);
  }
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.length} invoices → ${outDir}`);

// ---------------------------------------------------------------- helpers
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function invoiceNumberFor(vendorKey, n) {
  return { rustoleum: `SINV+${n}`, crown: `INV-${n}`, harlow: `${n}`, dropship: `DS/${n}/26` }[vendorKey] || `INV${n}`;
}
function creditNumberFor(vendorKey, n) {
  return { rustoleum: `SCRN+${n}`, crown: `CN-${n}`, harlow: `C${n}`, dropship: `DC/${n}/26` }[vendorKey] || `CN${n}`;
}
function refFor(style, po) {
  if (style === 'none') return null;
  if (style === 'legacy') return po.reference; // "IPO/316037"
  if (style === 'embedded') return `Order No. ${po.reference}-Harlow`; // "Order No. IPO 317792-Harlow"
  return po.number; // zoho: "PO-00012"
}
function expectedOutcome(inv, key) {
  if (inv.kind === 'credit_note') return inv.sameInvoiceNumberAs ? 'DUPLICATE (vendor credit exists)' : inv.againstInvoice ? 'CREDITED — vendor credit applied to the bill of invoice ' + inv.againstInvoice : 'CREDITED — vendor credit on the PO only, report says "not linked to any bill"';
  if (key === 'rounding') return 'Phase 1: BILLED — bill total = invoice total (adjustment +0.42) / Phase 2: PRICE_MISMATCH +0.4% (any increase → review)';
  if (key === 'mismatch') return 'TOTAL_MISMATCH (Phase 1) / PRICE_MISMATCH +11.8% (Phase 2)';
  if (key === 'price_lower') return 'TOTAL_MISMATCH (Phase 1) → BILLED at the invoice price 47.30 (−3.0%, within the 5% below-PO tolerance), noted (Phase 2)';
  if (key === 'price_lower_far') return 'TOTAL_MISMATCH (Phase 1) / PRICE_MISMATCH −10.0% (Phase 2, allowed down to −5%)';
  if (key === 'price_higher') return 'TOTAL_MISMATCH (Phase 1) / PRICE_MISMATCH +3.6% (Phase 2, increases always go to review)';
  if (key === 'carriage_zero') return 'TOTAL_MISMATCH (Phase 1) / CARRIAGE_MISMATCH — vendor rule Zero (Phase 2)';
  if (key === 'carriage_fixed') return 'TOTAL_MISMATCH (Phase 1) → BILLED with carriage 15.00 (Phase 2, Fixed ±5)';
  if (key === 'carriage_ignore' || key === 'prestashop') return 'TOTAL_MISMATCH (Phase 1) → BILLED with the invoice carriage (Phase 2, Ignore)';
  if (key === 'partial') return inv.suffix === 'A' ? 'TOTAL_MISMATCH (Phase 1) → BILLED partial 6 × primer (Phase 2)' : 'BILLED on remaining basis (Phase 1) / BILLED closing lines (Phase 2)';
  if (key === 'overqty') return 'TOTAL_MISMATCH (Phase 1) / QTY_EXCEEDS 5 > 3 (Phase 2)';
  if (key === 'duplicate' && inv.sameInvoiceNumberAs) return 'DUPLICATE';
  if (key === 'nopo') return 'NO_PO_REF';
  return 'BILLED';
}

function renderInvoice(file, d) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(fs.createWriteStream(file));
  const style = { rustoleum: 0, crown: 1, harlow: 2, dropship: 3 }[d.po.vendor] || 0;
  const date = new Date();
  const dateStr = [`${p2(date.getDate())}/${p2(date.getMonth() + 1)}/${date.getFullYear()}`, `${p2(date.getDate())}.${p2(date.getMonth() + 1)}.${date.getFullYear()}`, `${p2(date.getDate())}/${p2(date.getMonth() + 1)}/${String(date.getFullYear()).slice(2)}`, `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`][style];

  doc.fontSize(18).text(d.vendor.name, { align: style === 1 ? 'right' : 'left' });
  doc.fontSize(9).text(['Unit 4, Coatings Park, Leeds LS1 1AA', '12 Paint Street, Manchester M1 2BB', 'Harlow House, Hull HU3 3CC', 'Dropship Coatings, Dover CT16 4DD'][style], { align: style === 1 ? 'right' : 'left' });
  doc.moveDown();
  doc.fontSize(14).text(['INVOICE', 'TAX INVOICE', 'Invoice', 'SALES INVOICE'][style]);
  doc.moveDown(0.5);
  doc.fontSize(10);
  const invLabel = ['Invoice No.', 'Invoice Number:', 'INVOICE REF.', 'Inv. No.:'][style];
  const dateLabel = ['Document Date', 'Invoice Date:', 'INVOICE DATE', 'Date:'][style];
  const refLabel = ['Your Reference:', 'Customer PO:', 'CUSTOMER ORDER REF.', 'Your order:'][style];
  doc.text(`${invLabel} ${d.invoiceNumber}`);
  doc.text(`${dateLabel} ${dateStr}`);
  if (style === 2) doc.text(`ORDER No: S00${Math.floor(Math.random() * 9000 + 1000)}`); // supplier's own sales order — a trap
  if (d.ref) doc.text(`${refLabel} ${d.ref}`);
  doc.text(`Account: CUS${1000 + style}`);
  doc.text('Bill to: Customer Trade Ltd, Leeds');
  doc.moveDown();

  // table
  const cols = [50, 130, 360, 420, 490];
  const heads = [['Code', 'Description', 'Qty', 'Unit', 'Total'], ['Item Code', 'Product', 'Quantity', 'Price', 'Net'], ['REF', 'DESCRIPTION', 'QTY', 'RATE', 'AMOUNT'], ['Part No', 'Description', 'Qty', 'Unit Price', 'Line Total']][style];
  let y = doc.y;
  doc.font('Helvetica-Bold');
  heads.forEach((h, i) => doc.text(h, cols[i], y, { width: i === 1 ? 220 : 60, align: i >= 2 ? 'right' : 'left' }));
  doc.font('Helvetica');
  y += 16;
  for (const l of d.lines) {
    doc.text(l.mpn, cols[0], y); doc.text(l.name, cols[1], y, { width: 220 });
    doc.text(String(l.qty), cols[2], y, { width: 60, align: 'right' });
    doc.text(l.rate.toFixed(2), cols[3], y, { width: 60, align: 'right' });
    doc.text(l.total.toFixed(2), cols[4], y, { width: 60, align: 'right' });
    y += 16;
  }
  if (d.carriage) {
    doc.text('', cols[0], y); doc.text(['Carriage', 'Delivery', 'CARRIAGE & PACKING', 'Shipping'][style], cols[1], y, { width: 220 });
    doc.text(d.carriage.toFixed(2), cols[4], y, { width: 60, align: 'right' });
    y += 16;
  }
  y += 10;
  const totals = [
    [['Subtotal', d.net], ['VAT @ 20%', d.vat], ['Total GBP Incl. VAT', d.gross]],
    [['Net Amount', d.net + d.carriage], ['VAT', d.vat], ['Gross Amount', d.gross]],
    [['GOODS', d.net], ['VAT', d.vat], ['Total Due Amount GBP', d.gross]],
    [['Net', d.net + d.carriage], ['VAT 20%', d.vat], ['Total amount [GBP] incl. VAT', d.gross]],
  ][style];
  for (const [k, v] of totals) {
    doc.text(k, 330, y, { width: 150, align: 'right' });
    doc.text(v.toFixed(2), cols[4], y, { width: 60, align: 'right' });
    y += 16;
  }
  if (style === 1) { doc.text('Amount Paid', 330, y, { width: 150, align: 'right' }); doc.text('0.00', cols[4], y, { width: 60, align: 'right' }); y += 16; doc.text('Balance Due', 330, y, { width: 150, align: 'right' }); doc.text(d.gross.toFixed(2), cols[4], y, { width: 60, align: 'right' }); y += 16; }
  doc.moveDown(2);
  doc.fontSize(8).text(`VAT Reg GB ${123456700 + style}   Bank: Sort 40-00-0${style} Acc 1234567${style}   Terms: Net ${d.vendor.terms} days`, 50, y + 20);
  doc.end();
}
function renderCreditNote(file, d) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(fs.createWriteStream(file));
  const style = { rustoleum: 0, crown: 1, harlow: 2, dropship: 3 }[d.po.vendor] || 0;
  const date = new Date();
  const dateStr = [`${p2(date.getDate())}/${p2(date.getMonth() + 1)}/${date.getFullYear()}`, `${p2(date.getDate())}.${p2(date.getMonth() + 1)}.${date.getFullYear()}`, `${p2(date.getDate())}/${p2(date.getMonth() + 1)}/${String(date.getFullYear()).slice(2)}`, `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`][style];

  doc.fontSize(18).text(d.vendor.name, { align: style === 1 ? 'right' : 'left' });
  doc.fontSize(9).text(['Unit 4, Coatings Park, Leeds LS1 1AA', '12 Paint Street, Manchester M1 2BB', 'Harlow House, Hull HU3 3CC', 'Dropship Coatings, Dover CT16 4DD'][style], { align: style === 1 ? 'right' : 'left' });
  doc.moveDown();
  doc.fontSize(16).text(['CREDIT NOTE', 'TAX CREDIT NOTE', 'Credit Note', 'CREDIT MEMO'][style]);
  doc.moveDown(0.5);
  doc.fontSize(10);
  doc.text(`${['Credit Note No.', 'Credit Number:', 'CREDIT NOTE REF.', 'Credit No.:'][style]} ${d.creditNumber}`);
  doc.text(`${['Document Date', 'Credit Date:', 'CREDIT DATE', 'Date:'][style]} ${dateStr}`);
  if (d.againstInvoice) doc.text(`${['Against Invoice:', 'Original Invoice:', 'RE: INVOICE', 'Credit against invoice:'][style]} ${d.againstInvoice}`);
  if (style === 2) doc.text(`ORDER No: S00${Math.floor(Math.random() * 9000 + 1000)}`);
  if (d.ref) doc.text(`${['Your Reference:', 'Customer PO:', 'CUSTOMER ORDER REF.', 'Your order:'][style]} ${d.ref}`);
  doc.text(`Account: CUS${1000 + style}`);
  doc.text('Bill to: Customer Trade Ltd, Leeds');
  doc.text(['Reason: goods returned', 'Reason: damaged in transit', 'REASON: SHORT DELIVERY', 'Reason: pricing correction'][style]);
  doc.moveDown();

  const cols = [50, 130, 360, 420, 490];
  const heads = [['Code', 'Description', 'Qty', 'Unit', 'Credit'], ['Item Code', 'Product', 'Quantity', 'Price', 'Net'], ['REF', 'DESCRIPTION', 'QTY', 'RATE', 'AMOUNT'], ['Part No', 'Description', 'Qty', 'Unit Price', 'Line Total']][style];
  let y = doc.y;
  doc.font('Helvetica-Bold');
  heads.forEach((h, i) => doc.text(h, cols[i], y, { width: i === 1 ? 220 : 60, align: i >= 2 ? 'right' : 'left' }));
  doc.font('Helvetica');
  y += 16;
  const neg = style === 1; // one layout prints credits as negatives
  const amt = (n) => (neg ? `-${n.toFixed(2)}` : n.toFixed(2));
  for (const l of d.lines) {
    doc.text(l.mpn, cols[0], y); doc.text(l.name, cols[1], y, { width: 220 });
    doc.text(String(l.qty), cols[2], y, { width: 60, align: 'right' });
    doc.text(l.rate.toFixed(2), cols[3], y, { width: 60, align: 'right' });
    doc.text(amt(l.total), cols[4], y, { width: 60, align: 'right' });
    y += 16;
  }
  y += 10;
  const totals = [
    [['Credit Subtotal', d.net], ['VAT @ 20%', d.vat], ['Total Credit GBP Incl. VAT', d.gross]],
    [['Net Credit', d.net], ['VAT', d.vat], ['Total Credit', d.gross]],
    [['GOODS CREDITED', d.net], ['VAT', d.vat], ['TOTAL CREDIT GBP', d.gross]],
    [['Net', d.net], ['VAT 20%', d.vat], ['Total credit [GBP] incl. VAT', d.gross]],
  ][style];
  for (const [k, v] of totals) {
    doc.text(k, 330, y, { width: 150, align: 'right' });
    doc.text(amt(v), cols[4], y, { width: 60, align: 'right' });
    y += 16;
  }
  doc.moveDown(2);
  doc.fontSize(8).text(`VAT Reg GB ${123456700 + style}   This credit note ${d.againstInvoice ? `relates to invoice ${d.againstInvoice}` : 'may be offset against future invoices'}.`, 50, y + 20);
  doc.end();
}
function p2(n) { return String(n).padStart(2, '0'); }
