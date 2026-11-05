'use strict';

/**
 * Bill creation from a PO — the exact sequence proven on this org:
 *   GET  bills/editpage/frompurchaseorders?purchaseorder_ids=X   → pre-filled template
 *   POST bills                                                   → whitelisted payload
 *   POST bills/{id}/status/open                                  → only if Books left it as draft
 *   POST bills/{id}/attachment                                   → the source document
 *   (verify)                                                     → then, and only then, delete the inbox file
 */

/**
 * Build the whitelisted bill payload from the Books template.
 * Phase 1: full PO quantities (as the template provides them).
 * Phase 2 passes `quantities` = { purchaseorder_item_id: invoicedQty } to bill partially.
 */
function buildBillPayload({ template, invoiceNumber, invoiceDate, paymentTermsDays, paymentTermsLabel, quantities = null, rates = null, extraLines = [], maxBillNumberLen = 50, invoiceGross = null, adjustToInvoice = false, expectedTotal = null }) {
  const billNumber = String(invoiceNumber || '').trim().slice(0, maxBillNumberLen) || `bill-${Date.now()}`;

  const lineItems = [];
  for (const it of template.line_items || []) {
    const qty = quantities ? quantities[it.purchaseorder_item_id] : it.quantity;
    if (quantities && (qty === undefined || qty === null || qty <= 0)) continue; // not invoiced this time
    const li = {
      purchaseorder_item_id: it.purchaseorder_item_id,
      item_id: it.item_id,
      name: it.name,
      description: it.description,
      account_id: it.account_id,
      quantity: qty,
      rate: rates && rates[it.purchaseorder_item_id] !== undefined ? rates[it.purchaseorder_item_id] : it.rate, // Phase 2: the invoice price
    };
    if (it.tax_id) li.tax_id = it.tax_id;
    if (it.unit) li.unit = it.unit;
    lineItems.push(li);
  }
  for (const x of extraLines || []) lineItems.push(x); // e.g. carriage when the PO has no carriage line

  const payload = {
    vendor_id: template.vendor_id,
    bill_number: billNumber,
    date: invoiceDate || template.date,
    reference_number: template.reference_number,
    purchaseorder_ids: template.purchaseorder_ids,
    line_items: lineItems,
  };
  if (paymentTermsDays !== undefined && paymentTermsDays !== null) {
    payload.payment_terms = paymentTermsDays;
    if (paymentTermsLabel) payload.payment_terms_label = paymentTermsLabel;
  }
  if (template.currency_id) payload.currency_id = template.currency_id;
  if (template.exchange_rate) payload.exchange_rate = template.exchange_rate;
  if (template.is_inclusive_tax !== undefined) payload.is_inclusive_tax = template.is_inclusive_tax;

  // The bill must show the supplier's invoice total, not the PO's. Books prices the bill from the PO lines
  // (template.total); any difference inside the tolerance (rounding, pence) is posted as a bill adjustment.
  const adj = billAdjustment({ template, invoiceGross, adjustToInvoice, quantities, expectedTotal });
  if (adj) { payload.adjustment = adj; payload.adjustment_description = `Adjusted to supplier invoice ${billNumber} total`; }
  return payload;
}

/** Difference invoice − template total (2 dp), or 0 when disabled / unknown / below a penny. Full-quantity bills only (partial bills are priced by Phase 2). */
function billAdjustment({ template, invoiceGross, adjustToInvoice, quantities, expectedTotal = null }) {
  if (!adjustToInvoice) return 0;
  if (quantities && expectedTotal === null) return 0; // partial bill without a computed total: nothing to compare with
  const t = expectedTotal !== null ? Number(expectedTotal) : Number(template && template.total);
  const g = Number(invoiceGross);
  if (!Number.isFinite(t) || !Number.isFinite(g)) return 0;
  const d = Math.round((g - t) * 100) / 100;
  return Math.abs(d) < 0.01 ? 0 : d;
}

/**
 * Look up the PO's payment terms by id in the org's terms list (never by label).
 * Returns { days, label } or null.
 */
function paymentTermsFromPo(po, terms) {
  if (!po) return null;
  if (po.payment_terms !== undefined && po.payment_terms !== null && po.payment_terms !== '') {
    const match = (terms || []).find((t) => Number(t.payment_terms) === Number(po.payment_terms) && (!po.payment_terms_label || t.payment_terms_label === po.payment_terms_label));
    return { days: Number(po.payment_terms), label: match ? match.payment_terms_label : po.payment_terms_label || null };
  }
  return null;
}

/**
 * Create + open + attach. Returns { bill, attached:boolean }.
 * Throws BooksError on hard failures; attach failure is reported, not thrown.
 */
async function createBillWithAttachment({ books, logger, payload, document, poId }) {
  const bill = await books.createBill(payload);
  logger.info('bill.created', { bill_id: bill.bill_id, bill_number: bill.bill_number, po_id: poId });

  if (String(bill.status || '').toLowerCase() === 'draft') {
    await books.markBillOpen(bill.bill_id);
    logger.info('bill.marked_open', { bill_id: bill.bill_id });
  }

  let attached = false;
  try {
    const res = await books.attachToBill(bill.bill_id, document.buffer, document.fileName, document.mime);
    attached = res && res.code === 0;
  } catch (err) {
    logger.warn('bill.attach_failed', { bill_id: bill.bill_id, error: err });
  }
  return { bill, attached };
}

module.exports = { buildBillPayload, billAdjustment, paymentTermsFromPo, createBillWithAttachment };
