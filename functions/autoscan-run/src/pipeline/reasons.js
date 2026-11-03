'use strict';

/**
 * Exception reason codes — defined once, used by the pipeline, the state store
 * and the report. `action` is the one-line instruction finance sees.
 */
const REASONS = Object.freeze({
  NO_PO_REF: { retry: true, action: 'No PO reference could be read from the invoice. Check the document; if the PO is known, add it to the PO reference field in Books and the next run will match it, or bill manually.' },
  LOW_CONFIDENCE: { retry: true, action: 'The reader was not confident about this document. Review the values shown; fix the PO if needed or bill manually.' },
  PO_NOT_FOUND: { retry: true, action: 'The PO reference printed on the invoice does not exist in Books. Create or correct the PO; it will be re-checked automatically.' },
  TOTAL_MISMATCH: { retry: true, action: 'Invoice total differs from the PO. Amend the PO (or the invoice with the supplier); it will be re-checked automatically.' },
  DUPLICATE: { retry: false, action: 'A bill with this supplier invoice number already exists for this vendor. No action needed unless the existing bill is wrong; the inbox file was left in place.' },
  UNSUPPORTED_FILE: { retry: false, action: 'File type not supported (not PDF/JPG/PNG). Convert or bill manually.' },
  PAGE_LIMIT: { retry: false, action: 'Document exceeds the page limit (likely a statement or catalogue). Bill manually.' },
  NOT_AN_INVOICE: { retry: false, action: 'Document is not a supplier invoice (statement, credit note, delivery note…). Handle manually.' },
  AI_ERROR: { retry: true, action: 'Temporary reading error. Will be retried automatically.' },
  BOOKS_ERROR: { retry: true, action: 'Temporary Zoho Books error. Will be retried automatically.' },
  ATTACH_FAILED: { retry: true, action: 'Bill was created but the PDF could not be attached yet. Will be retried automatically.' },
  // Phase 2
  NO_MPN: { retry: true, action: 'One or more invoice lines have no product code (MPN). Bill manually.' },
  LINE_UNMATCHED: { retry: true, action: 'An invoice line does not match any PO line by MPN. Check the PO lines / item MPNs.' },
  PRICE_MISMATCH: { retry: true, action: 'Unit price on the invoice differs from the PO beyond tolerance. Amend the PO or query the supplier.' },
  QTY_EXCEEDS: { retry: true, action: 'Invoiced quantity exceeds the quantity remaining on the PO. Check the PO / previous bills.' },
  CARRIAGE_MISMATCH: { retry: true, action: 'Carriage differs from the PO beyond this supplier\'s tolerance. Amend the PO or the vendor\'s carriage rule.' },
});

function reason(code, text) {
  const def = REASONS[code] || { retry: true, action: '' };
  return { reason_code: code, reason_text: text || '', retry: def.retry, action: def.action };
}

module.exports = { REASONS, reason };
