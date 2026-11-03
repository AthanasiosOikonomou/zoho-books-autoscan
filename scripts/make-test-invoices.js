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

const VAT = 0.20;
const manifest = [];
let seq = 480000;

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
    const invoiceNumber = inv.sameInvoiceNumberAs
      ? manifest.find((m) => m.po_key === key && m.suffix === inv.sameInvoiceNumberAs).invoice_number
      : invoiceNumberFor(po.vendor, ++seq);
    const ref = refFor(inv.refStyle, po);
    const file = `${key}-${inv.suffix}.pdf`;
    renderInvoice(path.join(outDir, file), { vendor, po, inv, lines, net, carriage, vat, gross, invoiceNumber, ref });
    manifest.push({ file, po_key: key, suffix: inv.suffix, label: inv.label, vendor: vendor.name, po_number: po.number, po_reference: po.reference, printed_ref: ref, invoice_number: invoiceNumber, net, carriage, vat, gross, expected: expectedOutcome(inv, key) });
    console.log(`${file.padEnd(24)} ${invoiceNumber.padEnd(14)} ref="${ref || ''}" gross=${gross.toFixed(2)}  ${inv.label}`);
  }
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.length} invoices → ${outDir}`);

// ---------------------------------------------------------------- helpers
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function invoiceNumberFor(vendorKey, n) {
  return { rustoleum: `SINV+${n}`, crown: `INV-${n}`, harlow: `${n}`, dropship: `DS/${n}/26` }[vendorKey] || `INV${n}`;
}
function refFor(style, po) {
  if (style === 'none') return null;
  if (style === 'legacy') return po.reference; // "IPO/316037"
  if (style === 'embedded') return `Order No. ${po.reference}-Harlow`; // "Order No. IPO 317792-Harlow"
  return po.number; // zoho: "PO-00012"
}
function expectedOutcome(inv, key) {
  if (key === 'mismatch' || key === 'carriage_zero') return 'TOTAL_MISMATCH (Phase 1) / CARRIAGE_MISMATCH (Phase 2)';
  if (key === 'carriage_fixed' || key === 'carriage_ignore' || key === 'prestashop') return 'TOTAL_MISMATCH (Phase 1) → BILLED (Phase 2 with vendor rule)';
  if (key === 'partial') return 'TOTAL_MISMATCH (Phase 1) → BILLED partial (Phase 2)';
  if (key === 'overqty') return 'TOTAL_MISMATCH (Phase 1) / QTY_EXCEEDS (Phase 2)';
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
function p2(n) { return String(n).padStart(2, '0'); }
