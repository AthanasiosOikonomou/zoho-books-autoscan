'use strict';

/**
 * Supplier credit note → Zoho Books vendor credit.
 *
 * Rule: create the vendor credit and link it to the bill when the
 * bill and the PO can be found, otherwise to the PO only, and say in the report when
 * a credit note is not linked to any bill.
 *
 * Sequence:
 *   resolve PO (same resolver as invoices)           → PO_NOT_FOUND if missing
 *   dedupe: vendor + credit note number               → DUPLICATE
 *   find the bill: vendor + related invoice number    → optional
 *   build lines: credit-note lines → PO lines by MPN, else one account line
 *   create vendor credit (draft) → check total → open → apply to bill → attach → delete inbox file
 */

const { STATUS } = require('../state/store');
const { reason } = require('./reasons');
const { resolvePurchaseOrder } = require('./resolvePo');

/**
 * Map credit-note lines onto the PO's lines. Returns Books vendor-credit line_items.
 * A line matches a PO line by MPN against the PO line's sku / name / description (case-insensitive);
 * unmatched lines fall back to the account of the PO's first line so the credit still posts.
 */
function buildCreditLines({ extraction, po }) {
  const poLines = (po && po.line_items) || [];
  const key = (s) => String(s || '').trim().toLowerCase();
  const findPoLine = (mpn) => {
    const m = key(mpn);
    if (!m) return null;
    return poLines.find((l) => key(l.sku) === m) || poLines.find((l) => key(l.name).includes(m) || key(l.description).includes(m)) || null;
  };
  const fallbackAccount = poLines[0] && poLines[0].account_id;
  const fallbackTax = poLines[0] && poLines[0].tax_id;
  const out = [];
  for (const l of extraction.line_items || []) {
    const qty = Math.abs(Number(l.quantity)) || 1;
    const rate = Math.abs(Number(l.unit_price)) || (Number.isFinite(Number(l.line_total)) ? Math.abs(Number(l.line_total)) / qty : null);
    if (rate === null) continue;
    const hit = findPoLine(l.mpn);
    const li = { quantity: qty, rate, description: l.description || (hit && hit.name) || 'Credit' };
    if (hit) {
      if (hit.item_id) li.item_id = hit.item_id;
      if (hit.account_id) li.account_id = hit.account_id;
      if (hit.tax_id) li.tax_id = hit.tax_id;
      if (hit.name && !l.description) li.name = hit.name;
    } else if (fallbackAccount) {
      li.account_id = fallbackAccount;
      if (fallbackTax) li.tax_id = fallbackTax;
    }
    out.push(li);
  }
  const carriage = Math.abs(Number(extraction.totals && extraction.totals.carriage));
  if (carriage >= 0.01) {
    const carriageLine = poLines.find((l) => /carriage|delivery|shipping|postage/i.test(`${l.name} ${l.description}`));
    const li = { quantity: 1, rate: carriage, description: 'Carriage credited' };
    const src = carriageLine || poLines[0];
    if (src) { if (src.item_id && carriageLine) li.item_id = src.item_id; if (src.account_id) li.account_id = src.account_id; if (src.tax_id) li.tax_id = src.tax_id; }
    out.push(li);
  }
  if (!out.length) {
    // nothing line-shaped was read: one line for the net (or gross) amount on the PO's first account
    const net = Math.abs(Number(extraction.totals && extraction.totals.net));
    const gross = Math.abs(Number(extraction.totals && extraction.totals.gross));
    const amount = net >= 0.01 ? net : gross;
    if (amount >= 0.01) {
      const li = { quantity: 1, rate: amount, description: `Credit note ${extraction.invoice_number || ''} against PO ${po.purchaseorder_number || ''}`.trim() };
      if (fallbackAccount) li.account_id = fallbackAccount;
      if (net >= 0.01 && fallbackTax) li.tax_id = fallbackTax; // net given → let Books add the tax
      out.push(li);
    }
  }
  return out;
}

function buildVendorCreditPayload({ extraction, po, lines, relatedBill }) {
  const num = String(extraction.invoice_number || '').trim().slice(0, 50) || `CN-${po.purchaseorder_number}-${Date.now()}`;
  const notes = [`Credit note ${num} against PO ${po.purchaseorder_number}`, relatedBill ? `for bill ${relatedBill.bill_number}` : extraction.related_invoice_number ? `for supplier invoice ${extraction.related_invoice_number} (bill not found)` : 'no related invoice printed'].join(' ');
  const payload = {
    vendor_id: po.vendor_id,
    vendor_credit_number: num,
    date: extraction.invoice_date || undefined,
    reference_number: po.purchaseorder_number,
    notes,
    line_items: lines,
  };
  if (po.currency_id) payload.currency_id = po.currency_id;
  if (po.is_inclusive_tax !== undefined) payload.is_inclusive_tax = po.is_inclusive_tax;
  return payload;
}

/**
 * Handle one credit-note document. `h` is the processDocument harness:
 * { ctx, config, books, logger, documentId, extraction, rec, result, finish, getDocument }.
 */
async function processCreditNote(h) {
  const { ctx, config, books, logger, documentId, extraction, rec, result, finish, getDocument } = h;
  const gross = Math.abs(Number(extraction.totals && extraction.totals.gross));
  const num = extraction.invoice_number;

  if (!extraction.po_reference) return finish(STATUS.EXCEPTION, reason('NO_PO_REF', 'credit note: no PO reference read'));
  if (extraction.confidence < config.matching.confidenceThreshold) {
    return finish(STATUS.EXCEPTION, reason('LOW_CONFIDENCE', `credit note: confidence ${extraction.confidence} < ${config.matching.confidenceThreshold}`));
  }
  if (!Number.isFinite(gross) || gross < 0.01) return finish(STATUS.EXCEPTION, reason('CREDIT_NOTE', 'credit note: no total read'));

  // 1. PO
  const { po: poHit, strategy } = await resolvePurchaseOrder(books, extraction.po_reference, config.matching);
  if (!poHit) return finish(STATUS.EXCEPTION, reason('PO_NOT_FOUND', `credit note: ref "${extraction.po_reference}" not found`));
  const po = await books.getPurchaseOrder(poHit.purchaseorder_id);
  Object.assign(rec, { po_id: po.purchaseorder_id, po_number: po.purchaseorder_number, vendor_id: po.vendor_id, vendor_name: po.vendor_name || rec.vendor_name });
  result.links.po = `${config.report.booksAppBase}#/purchaseorders/${po.purchaseorder_id}`;
  result.po = { number: po.purchaseorder_number, total: po.total, vendor: po.vendor_name, strategy };
  result.credit = { number: num, gross, related_invoice: extraction.related_invoice_number || null };

  // 2. dedupe (credit note number per vendor; in-run claim first)
  if (num) {
    const claimKey = `credit|${po.vendor_id}|${String(num).trim().toLowerCase()}`;
    const claims = ctx.claims || (ctx.claims = new Map());
    const holder = claims.get(claimKey);
    if (holder && holder !== documentId) return finish(STATUS.DUPLICATE, reason('DUPLICATE', `same credit note number as document ${holder} in this run`));
    claims.set(claimKey, documentId);
    const dupes = await books.searchVendorCredits({ vendor_id: po.vendor_id, vendor_credit_number: num });
    const exact = dupes.find((c) => String(c.vendor_credit_number).toLowerCase() === String(num).toLowerCase());
    if (exact) {
      result.links.credit = `${config.report.booksAppBase}#/vendorcredits/${exact.vendor_credit_id}`;
      return finish(STATUS.DUPLICATE, reason('DUPLICATE', `vendor credit ${exact.vendor_credit_number} exists`), { credit_id: exact.vendor_credit_id, credit_number: exact.vendor_credit_number });
    }
  }

  // 3. the bill it belongs to (optional)
  let relatedBill = null;
  if (extraction.related_invoice_number) {
    const bills = await books.searchBills({ vendor_id: po.vendor_id, bill_number: extraction.related_invoice_number });
    relatedBill = bills.find((b) => String(b.bill_number).toLowerCase() === String(extraction.related_invoice_number).toLowerCase()) || null;
  }
  if (!relatedBill) {
    // no (or unknown) invoice reference: a PO with exactly one bill is unambiguous
    const linked = await books.searchBills({ purchaseorder_id: po.purchaseorder_id });
    if (linked.length === 1 && !extraction.related_invoice_number) relatedBill = linked[0];
  }
  if (relatedBill) {
    Object.assign(rec, { bill_id: relatedBill.bill_id, bill_number: relatedBill.bill_number });
    result.links.bill = `${config.report.booksAppBase}#/bills/${relatedBill.bill_id}`;
  }
  result.credit.bill = relatedBill ? relatedBill.bill_number : null;

  // 4. lines
  const lines = buildCreditLines({ extraction, po });
  if (!lines.length) return finish(STATUS.EXCEPTION, reason('CREDIT_NOTE', 'credit note: no lines or amounts could be read'));
  const payload = buildVendorCreditPayload({ extraction, po, lines, relatedBill });

  if (config.run.dryRun) {
    result.note = relatedBill ? `would credit bill ${relatedBill.bill_number}` : 'would create the vendor credit against the PO only — not linked to any bill';
    return finish(STATUS.WOULD_CREDIT, null, {});
  }

  // 5. create → verify total → open
  const credit = await books.createVendorCredit(payload);
  logger.info('credit.created', { vendor_credit_id: credit.vendor_credit_id, number: credit.vendor_credit_number, po_id: po.purchaseorder_id });
  result.links.credit = `${config.report.booksAppBase}#/vendorcredits/${credit.vendor_credit_id}`;
  const creditTotal = Number(credit.total);
  if (Number.isFinite(creditTotal) && Math.abs(creditTotal - gross) > config.matching.totalTolerance) {
    // Books priced the lines differently from the printed credit note: do not leave a wrong figure behind
    try { await books.deleteVendorCredit(credit.vendor_credit_id); } catch (err) { logger.warn('credit.delete_failed', { vendor_credit_id: credit.vendor_credit_id, error: err }); }
    delete result.links.credit;
    return finish(STATUS.EXCEPTION, reason('CREDIT_TOTAL_MISMATCH', `Books priced the credit at ${creditTotal.toFixed(2)} but the credit note says ${gross.toFixed(2)}`));
  }
  if (String(credit.status || '').toLowerCase() === 'draft') {
    await books.markVendorCreditOpen(credit.vendor_credit_id);
  }
  const notes = [];
  if (Number.isFinite(creditTotal) && Math.abs(creditTotal - gross) >= 0.01) notes.push(`credit total ${creditTotal.toFixed(2)} differs from the note ${gross.toFixed(2)}`);

  // 6. apply to the bill when it has balance
  let applied = 0;
  if (relatedBill) {
    try {
      const bill = await books.getBill(relatedBill.bill_id);
      const balance = Number(bill && bill.balance);
      const amount = Math.min(Number.isFinite(creditTotal) ? creditTotal : gross, Number.isFinite(balance) ? balance : 0);
      if (amount >= 0.01) {
        await books.applyVendorCreditToBill(credit.vendor_credit_id, relatedBill.bill_id, Math.round(amount * 100) / 100);
        applied = amount;
        logger.info('credit.applied', { vendor_credit_id: credit.vendor_credit_id, bill_id: relatedBill.bill_id, amount });
      } else {
        notes.push(`bill ${relatedBill.bill_number} has no balance (already paid) — credit left unapplied`);
      }
    } catch (err) {
      logger.warn('credit.apply_failed', { vendor_credit_id: credit.vendor_credit_id, bill_id: relatedBill.bill_id, error: err });
      notes.push(`could not apply to bill ${relatedBill.bill_number}: ${err && err.message ? err.message : err}`);
    }
  } else {
    notes.push(`not linked to any bill (PO ${po.purchaseorder_number} only${extraction.related_invoice_number ? `; invoice ${extraction.related_invoice_number} not found` : ''})`);
  }
  result.credit.applied = applied;

  // 7. attach + delete the inbox file (only after the attachment is confirmed)
  let attached = false;
  try {
    const document = await getDocument();
    const res = await books.attachToVendorCredit(credit.vendor_credit_id, document.buffer, document.fileName, document.mime);
    attached = res && res.code === 0;
  } catch (err) {
    logger.warn('credit.attach_failed', { vendor_credit_id: credit.vendor_credit_id, error: err });
  }
  if (attached) await books.deleteDocument(documentId);
  else notes.push('PDF could not be attached to the vendor credit — file left in the inbox');

  result.note = notes.join('; ') || null;
  return finish(STATUS.CREDITED, null, { credit_id: credit.vendor_credit_id, credit_number: credit.vendor_credit_number || num });
}

module.exports = { processCreditNote, buildCreditLines, buildVendorCreditPayload };
