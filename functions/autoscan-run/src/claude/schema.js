'use strict';

/**
 * Tool definition that forces Claude to answer with a schema-valid object.
 * Keep this the single source of truth for the extraction shape; the
 * pipeline reads these field names.
 */
const nullableString = { type: ['string', 'null'] };
const nullableNumber = { type: ['number', 'null'] };

const RECORD_INVOICE_TOOL = {
  name: 'record_invoice',
  description: 'Record the fields read from one supplier invoice document exactly as printed.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['invoice_number', 'invoice_date', 'po_reference', 'supplier_name', 'totals', 'line_items', 'confidence', 'evidence', 'document_type'],
    properties: {
      document_type: { type: 'string', enum: ['invoice', 'credit_note', 'statement', 'delivery_note', 'quotation', 'remittance', 'other'] },
      invoice_number: nullableString,
      invoice_date: { ...nullableString, description: 'ISO 8601 date YYYY-MM-DD' },
      po_reference: { ...nullableString, description: 'Customer PO reference verbatim as printed' },
      supplier_name: nullableString,
      currency: { ...nullableString, description: 'ISO 4217 if printed, e.g. GBP' },
      totals: {
        type: 'object',
        additionalProperties: false,
        required: ['net', 'vat', 'carriage', 'gross'],
        properties: { net: nullableNumber, vat: nullableNumber, carriage: nullableNumber, gross: nullableNumber },
      },
      line_items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['mpn', 'description', 'quantity', 'unit_price', 'line_total'],
          properties: {
            mpn: nullableString,
            description: { type: 'string' },
            quantity: nullableNumber,
            unit_price: nullableNumber,
            line_total: nullableNumber,
          },
        },
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      evidence: { type: 'string' },
      notes: { ...nullableString, description: 'One short sentence on anything unusual' },
    },
  },
};

/** Defensive normalisation of whatever came back (model output is data, not truth). */
function normaliseExtraction(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round((v + Number.EPSILON) * 100) / 100 : null);
  const totals = r.totals && typeof r.totals === 'object' ? r.totals : {};
  const lines = Array.isArray(r.line_items) ? r.line_items : [];
  return {
    document_type: str(r.document_type) || 'invoice',
    invoice_number: str(r.invoice_number),
    invoice_date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.invoice_date || '')) ? r.invoice_date : null,
    po_reference: str(r.po_reference),
    supplier_name: str(r.supplier_name),
    currency: str(r.currency),
    totals: { net: num(totals.net), vat: num(totals.vat), carriage: num(totals.carriage), gross: num(totals.gross) },
    line_items: lines.map((l) => ({
      mpn: str(l && l.mpn),
      description: str(l && l.description) || '',
      quantity: num(l && l.quantity),
      unit_price: num(l && l.unit_price),
      line_total: num(l && l.line_total),
    })),
    confidence: typeof r.confidence === 'number' ? Math.max(0, Math.min(1, r.confidence)) : 0,
    evidence: str(r.evidence) || '',
    notes: str(r.notes),
  };
}

module.exports = { RECORD_INVOICE_TOOL, normaliseExtraction };
