'use strict';

const { errorMessage } = require('../logger');

const { STATUS } = require('../state/store');
const { reason } = require('./reasons');
const { resolvePurchaseOrder } = require('./resolvePo');
const { matchTotals, sumBilled } = require('./match');
const { buildBillPayload, paymentTermsFromPo, createBillWithAttachment } = require('./bill');
const { detectMime, isSupported, estimatePageCount } = require('../util/mime');
const { sha256 } = require('../util/hash');
const { estimateCostUsd } = require('../claude/extractor');

// Reasons that come from the *reading* of the document: when the prompt changes, read again.
const EXTRACTION_REASONS = new Set(['NO_PO_REF', 'LOW_CONFIDENCE', 'PO_NOT_FOUND', 'NOT_AN_INVOICE', 'CREDIT_NOTE', 'AI_ERROR', 'UNSUPPORTED_FILE']);

/**
 * Process ONE inbox document end to end. Never throws: every outcome is a
 * state record + a result row for the report.
 *
 * @param {object} ctx  { config, books, extractor, store, logger, terms, runId, now }
 * @param {object} doc  Books inbox document { document_id, file_name, ... }
 * @param {object|null} prior  existing state record (retry) or null (new)
 */
async function processDocument(ctx, doc, prior) {
  const { config, books, extractor, store, logger, terms, runId } = ctx;
  const now = ctx.now ? ctx.now() : new Date();
  const mode = prior ? 'retry' : 'new';
  const documentId = String(doc.document_id);
  const fileName = doc.file_name || (prior && prior.file_name) || `document-${documentId}`;

  const rec = {
    document_id: documentId,
    file_name: fileName,
    first_seen: (prior && prior.first_seen) || now.toISOString(),
    last_attempt: now.toISOString(),
    attempts: ((prior && prior.attempts) || 0) + 1,
    run_id: runId,
    claimed_run_id: runId,
    status: STATUS.PROCESSING,
  };
  const result = { document_id: documentId, file_name: fileName, mode, status: null, reason_code: null, reason_text: null, action: null, links: {}, ai: null, cost_usd: 0 };

  const finish = async (status, r, extra = {}) => {
    Object.assign(rec, { status, reason_code: r ? r.reason_code : null, reason_text: r ? r.reason_text : null }, extra);
    await store.upsert(rec);
    Object.assign(result, { status, reason_code: rec.reason_code, reason_text: rec.reason_text, action: r ? r.action : null }, extra);
    return result;
  };

  try {
    await store.upsert({ ...rec }); // claim

    // ---------------------------------------------------------------- 1. file + extraction
    let document = null; // { buffer, mime, fileName }
    let extraction = prior && prior.extraction_json ? safeParse(prior.extraction_json) : null;
    const promptVersion = extractor.promptVersion || null;
    if (extraction && promptVersion && prior.prompt_version !== promptVersion && EXTRACTION_REASONS.has(prior.reason_code)) {
      logger.info('extraction.stale_prompt', { document_id: documentId, was: prior.prompt_version, now: promptVersion, reason: prior.reason_code });
      extraction = null; // re-read with the current prompt
    }

    if (!extraction) {
      const dl = await books.downloadDocument(documentId);
      const mime = detectMime(dl.buffer, fileName);
      const hash = sha256(dl.buffer);
      document = { buffer: dl.buffer, mime, fileName: dl.fileName || fileName };
      Object.assign(rec, { file_hash: hash, mime, pages: estimatePageCount(dl.buffer, mime) });

      if (!isSupported(mime)) return finish(STATUS.EXCEPTION, reason('UNSUPPORTED_FILE', `mime ${mime}`));
      if (rec.pages > config.claude.pageCap) return finish(STATUS.EXCEPTION, reason('PAGE_LIMIT', `${rec.pages} pages > cap ${config.claude.pageCap}`));

      const seen = await store.findByHash(hash);
      if (seen && seen.extraction_json && seen.document_id !== documentId && (!promptVersion || seen.prompt_version === promptVersion)) {
        extraction = safeParse(seen.extraction_json);
        rec.extraction_json = seen.extraction_json;
        rec.model = seen.model;
        rec.prompt_version = seen.prompt_version;
        logger.info('extraction.reused_by_hash', { document_id: documentId, from: seen.document_id });
      } else {
        try {
          const out = await extractor.extract(dl.buffer, mime);
          extraction = out.extraction;
          rec.extraction_json = JSON.stringify(extraction);
          rec.model = out.usage.model;
          rec.prompt_version = promptVersion;
          rec.tokens_in = out.usages.reduce((s, u) => s + u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, 0);
          rec.tokens_out = out.usages.reduce((s, u) => s + u.output_tokens, 0);
          result.cost_usd = out.usages.reduce((s, u) => s + estimateCostUsd(u), 0);
          result.ai = { model: rec.model, tokens_in: rec.tokens_in, tokens_out: rec.tokens_out };
        } catch (err) {
          logger.warn('extraction.failed', { document_id: documentId, error: err });
          return finish(STATUS.EXCEPTION, reason('AI_ERROR', errorMessage(err)));
        }
      }
    }

    result.extracted = summarise(extraction);
    Object.assign(rec, { invoice_number: extraction.invoice_number, invoice_date: extraction.invoice_date, invoice_gross: extraction.totals.gross, vendor_name: extraction.supplier_name });

    if (extraction.document_type === 'credit_note') {
      return finish(STATUS.EXCEPTION, reason('CREDIT_NOTE', `credit note${extraction.po_reference ? ` for ${extraction.po_reference}` : ''}${extraction.invoice_number ? ` (${extraction.invoice_number})` : ''}`));
    }
    if (extraction.document_type && extraction.document_type !== 'invoice') {
      return finish(STATUS.EXCEPTION, reason('NOT_AN_INVOICE', `document_type=${extraction.document_type}`));
    }
    if (!extraction.po_reference) return finish(STATUS.EXCEPTION, reason('NO_PO_REF', 'no PO reference read'));
    if (extraction.confidence < config.matching.confidenceThreshold) {
      return finish(STATUS.EXCEPTION, reason('LOW_CONFIDENCE', `confidence ${extraction.confidence} < ${config.matching.confidenceThreshold}`));
    }

    // ---------------------------------------------------------------- 2. resolve PO
    const { po: poHit, strategy } = await resolvePurchaseOrder(books, extraction.po_reference, config.matching);
    if (!poHit) return finish(STATUS.EXCEPTION, reason('PO_NOT_FOUND', `ref "${extraction.po_reference}" not found`));
    const po = await books.getPurchaseOrder(poHit.purchaseorder_id);
    Object.assign(rec, { po_id: po.purchaseorder_id, po_number: po.purchaseorder_number, vendor_id: po.vendor_id, vendor_name: po.vendor_name || rec.vendor_name });
    result.links.po = `${config.report.booksAppBase}#/purchaseorders/${po.purchaseorder_id}`;
    result.po = { number: po.purchaseorder_number, total: po.total, vendor: po.vendor_name, strategy };

    // ---------------------------------------------------------------- 3. dedupe (supplier invoice no. per vendor)
    //    a) against Books; b) against documents claimed earlier in THIS run (two copies in one batch)
    let claimKey = null;
    if (extraction.invoice_number) {
      claimKey = `${po.vendor_id}|${String(extraction.invoice_number).trim().toLowerCase()}`;
      const claims = ctx.claims || (ctx.claims = new Map());
      const holder = claims.get(claimKey);
      if (holder && holder !== documentId) {
        return finish(STATUS.DUPLICATE, reason('DUPLICATE', `same supplier invoice number as document ${holder} in this run`), {});
      }
      claims.set(claimKey, documentId); // claim synchronously, BEFORE the first await, so parallel workers see it
      const dupes = await books.searchBills({ vendor_id: po.vendor_id, bill_number: extraction.invoice_number });
      const exact = dupes.find((b) => String(b.bill_number).toLowerCase() === String(extraction.invoice_number).toLowerCase());
      if (exact) {
        result.links.bill = `${config.report.booksAppBase}#/bills/${exact.bill_id}`;
        return finish(STATUS.DUPLICATE, reason('DUPLICATE', `bill ${exact.bill_number} exists`), { bill_id: exact.bill_id, bill_number: exact.bill_number });
      }
    }

    // ---------------------------------------------------------------- 4. match (Phase 1 totals)
    const linkedBills = config.matching.compareAgainstRemaining ? await books.searchBills({ purchaseorder_id: po.purchaseorder_id }) : [];
    const m = matchTotals({
      invoiceGross: extraction.totals.gross,
      poTotal: po.total,
      billedTotal: sumBilled(linkedBills),
      tolerance: config.matching.totalTolerance,
      compareAgainstRemaining: config.matching.compareAgainstRemaining,
    });
    result.match = m;
    if (!m.ok) {
      const txt = `invoice ${fmt(m.invoiceGross)} vs PO ${fmt(m.poTotal)}${m.billedTotal ? ` (remaining ${fmt(m.remaining)})` : ''}, diff ${fmt(m.difference)}`;
      return finish(STATUS.EXCEPTION, reason('TOTAL_MISMATCH', txt));
    }

    // ---------------------------------------------------------------- 5. bill
    const terms_ = paymentTermsFromPo(po, terms);
    if (config.run.dryRun) {
      return finish(STATUS.WOULD_BILL, null, { bill_id: null });
    }

    // retry of an attach-only failure: bill exists, just attach
    if (prior && prior.status === STATUS.BILLED_NO_ATTACH && prior.bill_id) {
      if (!document) document = await downloadAsDocument(books, documentId, fileName);
      const res = await books.attachToBill(prior.bill_id, document.buffer, document.fileName, document.mime);
      if (!(res && res.code === 0)) return finish(STATUS.BILLED_NO_ATTACH, reason('ATTACH_FAILED', 'attach retry failed'), { bill_id: prior.bill_id, bill_number: prior.bill_number });
      await books.deleteDocument(documentId);
      result.links.bill = `${config.report.booksAppBase}#/bills/${prior.bill_id}`;
      return finish(STATUS.BILLED, null, { bill_id: prior.bill_id, bill_number: prior.bill_number });
    }

    const template = await books.getBillFromPurchaseOrders(po.purchaseorder_id);
    // Safety net: Books computes the template's total from the quantities it proposes
    // (remaining quantities on a partially billed PO). If that is not the invoice
    // amount, creating the bill would post the wrong figure — stop here instead.
    const templateTotal = Number(template && template.total);
    if (Number.isFinite(templateTotal) && Math.abs(templateTotal - extraction.totals.gross) > config.matching.totalTolerance) {
      return finish(STATUS.EXCEPTION, reason('BILL_TEMPLATE_MISMATCH', `Books would bill ${fmt(templateTotal)} from the PO's remaining quantities but the invoice is ${fmt(extraction.totals.gross)}`));
    }
    const payload = buildBillPayload({
      template,
      invoiceNumber: extraction.invoice_number || `${po.purchaseorder_number}-${documentId}`,
      invoiceDate: extraction.invoice_date,
      paymentTermsDays: terms_ ? terms_.days : undefined,
      paymentTermsLabel: terms_ ? terms_.label : undefined,
      invoiceGross: extraction.totals.gross,
      adjustToInvoice: config.matching.billAdjustToInvoice,
    });
    if (!document) document = await downloadAsDocument(books, documentId, fileName);
    const { bill, attached } = await createBillWithAttachment({ books, logger, payload, document, poId: po.purchaseorder_id });
    result.links.bill = `${config.report.booksAppBase}#/bills/${bill.bill_id}`;
    const billTotal = Number(bill && bill.total);
    if (Number.isFinite(billTotal) && Math.abs(billTotal - extraction.totals.gross) >= 0.01) {
      // Bill exists with a different figure than the invoice (adjustment not applied / tax recomputed) — flag it, never silently.
      result.note = `bill total ${fmt(billTotal)} differs from invoice ${fmt(extraction.totals.gross)}`;
      logger.warn('bill.total_differs', { bill_id: bill.bill_id, bill_total: billTotal, invoice_total: extraction.totals.gross, adjustment: payload.adjustment || 0 });
    }

    if (!attached) {
      return finish(STATUS.BILLED_NO_ATTACH, reason('ATTACH_FAILED', 'attachment not confirmed'), { bill_id: bill.bill_id, bill_number: bill.bill_number });
    }
    await books.deleteDocument(documentId);
    return finish(STATUS.BILLED, null, { bill_id: bill.bill_id, bill_number: bill.bill_number });
  } catch (err) {
    logger.error('document.failed', { document_id: documentId, error: err });
    if (err && err.code === 'BOOKS_DAILY_LIMIT') throw err; // let the run stop cleanly
    const code = err && String(err.code || '').startsWith('BOOKS') ? 'BOOKS_ERROR' : 'AI_ERROR';
    return finish(STATUS.EXCEPTION, reason(code, errorMessage(err)));
  }
}

async function downloadAsDocument(books, documentId, fileName) {
  const dl = await books.downloadDocument(documentId);
  return { buffer: dl.buffer, mime: detectMime(dl.buffer, fileName), fileName: dl.fileName || fileName };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function fmt(n) { return Number.isFinite(n) ? n.toFixed(2) : String(n); }
function summarise(e) {
  return {
    invoice_number: e.invoice_number,
    invoice_date: e.invoice_date,
    po_reference: e.po_reference,
    supplier_name: e.supplier_name,
    gross: e.totals.gross,
    net: e.totals.net,
    vat: e.totals.vat,
    carriage: e.totals.carriage,
    lines: e.line_items.length,
    confidence: e.confidence,
    evidence: e.evidence,
  };
}

module.exports = { processDocument };
