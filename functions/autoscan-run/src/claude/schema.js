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
    required: ['invoice_number', 'invoice_date', 'invoice_date_raw', 'po_reference', 'supplier_name', 'totals', 'charges', 'line_items', 'confidence', 'evidence', 'document_type'],
    properties: {
      document_type: { type: 'string', enum: ['invoice', 'credit_note', 'statement', 'delivery_note', 'quotation', 'remittance', 'other'] },
      invoice_number: nullableString,
      invoice_date: { ...nullableString, description: 'ISO 8601 date YYYY-MM-DD' },
      invoice_date_raw: { ...nullableString, description: 'The same invoice date copied exactly as printed, e.g. 01.10.2026, 27/10/26, 12 Nov 2026' },
      po_reference: { ...nullableString, description: 'Customer PO reference verbatim as printed' },
      related_invoice_number: { ...nullableString, description: 'Credit notes only: the supplier invoice number this credit note refers to, verbatim; null if not printed' },
      supplier_name: nullableString,
      currency: { ...nullableString, description: 'ISO 4217 if printed, e.g. GBP' },
      totals: {
        type: 'object',
        additionalProperties: false,
        required: ['net', 'vat', 'carriage', 'gross'],
        properties: { net: nullableNumber, vat: nullableNumber, carriage: nullableNumber, gross: nullableNumber },
      },
      charges: {
        type: 'array',
        description: 'Every delivery-type charge on the document (carriage, delivery, freight, shipping, postage, packing, handling, surcharges), one entry per printed amount, net of VAT. Empty when there is none.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['description', 'amount'],
          properties: { description: { type: 'string' }, amount: nullableNumber },
        },
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
  const notes = [str(r.notes)].filter(Boolean);

  // The model copies, the code computes. Date: the printed text is converted here (day first, as UK suppliers print);
  // the model's own ISO conversion is only the fallback.
  const modelDate = /^\d{4}-\d{2}-\d{2}$/.test(String(r.invoice_date || '')) ? r.invoice_date : null;
  const rawDate = str(r.invoice_date_raw);
  const printedDate = parsePrintedDate(rawDate);
  if (printedDate && modelDate && printedDate !== modelDate) notes.push(`date printed "${rawDate}" = ${printedDate} (the model wrote ${modelDate})`);

  // Carriage: the sum of the charges listed one by one, added up here — never the model's own addition.
  const charges = (Array.isArray(r.charges) ? r.charges : []).map((c) => ({ description: str(c && c.description) || '', amount: num(c && c.amount) })).filter((c) => c.amount !== null && c.amount !== 0);
  const modelCarriage = num(totals.carriage);
  let carriage = modelCarriage;
  if (charges.length) {
    carriage = Math.round((charges.reduce((s, c) => s + Math.abs(c.amount), 0) + Number.EPSILON) * 100) / 100;
    if (modelCarriage !== null && Math.abs(Math.abs(modelCarriage) - carriage) >= 0.01) notes.push(`carriage ${carriage.toFixed(2)} = ${charges.map((c) => Math.abs(c.amount).toFixed(2)).join(' + ')} (the model wrote ${modelCarriage.toFixed(2)})`);
  }
  return {
    document_type: str(r.document_type) || 'invoice',
    invoice_number: str(r.invoice_number),
    invoice_date: printedDate || modelDate,
    invoice_date_raw: rawDate,
    po_reference: str(r.po_reference),
    related_invoice_number: str(r.related_invoice_number),
    supplier_name: str(r.supplier_name),
    currency: str(r.currency),
    totals: { net: num(totals.net), vat: num(totals.vat), carriage, gross: num(totals.gross) },
    charges,
    line_items: lines.map((l) => ({
      mpn: str(l && l.mpn),
      description: str(l && l.description) || '',
      quantity: num(l && l.quantity),
      unit_price: num(l && l.unit_price),
      line_total: num(l && l.line_total),
    })),
    confidence: typeof r.confidence === 'number' ? Math.max(0, Math.min(1, r.confidence)) : 0,
    evidence: str(r.evidence) || '',
    notes: notes.length ? notes.join(' — ') : null,
  };
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/**
 * A date as a supplier prints it → ISO, or null when it is not recognised. Numeric dates are read day first
 * (01.10.2026 = 1 October); only when the second number cannot be a month (11/25/2026) are the two swapped.
 * Accepted: 13/01/2026 · 14.01.2026 · 06-01-26 · 2026-01-14 · 12 Nov 2026 · 12-Nov-26 · 12 November 2026 · November 12, 2026.
 */
function parsePrintedDate(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const year = (y) => (String(y).length === 2 ? 2000 + Number(y) : Number(y));
  const iso = (y, m, d) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (y < 2000 || y > 2100 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})\b/);
  if (m) {
    let d = Number(m[1]); let mo = Number(m[2]);
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return iso(year(m[3]), mo, d);
  }
  m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?[\s.-]+([A-Za-z]{3,9})\.?,?[\s.-]+(\d{4}|\d{2})\b/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return iso(year(m[3]), MONTHS[m[2].slice(0, 3).toLowerCase()], Number(m[1]));
  m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return iso(Number(m[3]), MONTHS[m[1].slice(0, 3).toLowerCase()], Number(m[2]));
  return null;
}

module.exports = { RECORD_INVOICE_TOOL, normaliseExtraction, parsePrintedDate };
