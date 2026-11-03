'use strict';

/**
 * Turn whatever the supplier printed into the Books PO, trying the cheapest
 * and most likely lookups first. Returns { po, strategy } or { po: null, tried }.
 *
 * Candidate generation from a printed reference, e.g.
 *   "IPO/316037"          → ["IPO/316037", "PO-316037", "316037"]
 *   "PO-00235"            → ["PO-00235", "PO-235"...]
 *   "IPO 317792-Harlow"  → ["IPO 317792-Harlow", "PO-317792", "317792"]
 *   "235"                 → ["PO-00235", "235"]
 */
function candidatesFor(ref, { poPrefix = 'PO-', poPadWidth = 5, legacyPrefixes = ['IPO/', 'IPO ', 'IPO-'] } = {}) {
  const out = [];
  const push = (v) => { if (v && !out.includes(v)) out.push(v); };

  const raw = String(ref || '').trim();
  if (!raw) return out;
  push(raw);

  // strip common legacy prefixes
  let core = raw;
  for (const p of legacyPrefixes) {
    if (core.toUpperCase().startsWith(p.toUpperCase())) { core = core.slice(p.length).trim(); break; }
  }
  push(core);

  // first digit run of 4+ digits (ignores trailing "-Harlow" etc.)
  const digits = (core.match(/\d{4,}/) || [])[0];
  if (digits) {
    push(`${poPrefix}${digits}`);
    push(`${poPrefix}${digits.padStart(poPadWidth, '0')}`);
    push(`${poPrefix}${digits.replace(/^0+/, '')}`);
    push(digits);
    push(digits.replace(/^0+/, ''));
  } else {
    const short = (core.match(/\d+/) || [])[0];
    if (short) { push(`${poPrefix}${short.padStart(poPadWidth, '0')}`); push(short); }
  }

  // already prefixed with the Books prefix → also try without
  if (core.toUpperCase().startsWith(poPrefix.toUpperCase())) push(core.slice(poPrefix.length));

  return out;
}

/**
 * @param {object} books   Books client
 * @param {string} ref     printed PO reference
 * @param {object} opts    matching config
 */
async function resolvePurchaseOrder(books, ref, opts = {}) {
  const tried = [];
  const cands = candidatesFor(ref, opts);

  // 1) exact purchaseorder_number for each candidate (stop at first hit)
  for (const c of cands) {
    tried.push({ field: 'purchaseorder_number', value: c });
    const hits = await books.searchPurchaseOrders({ purchaseorder_number: c });
    const exact = hits.find((p) => String(p.purchaseorder_number).toLowerCase() === c.toLowerCase());
    if (exact) return { po: exact, strategy: `purchaseorder_number=${c}`, tried };
  }

  // 2) reference_number (legacy refs are often stored here after migration)
  for (const c of cands.slice(0, 3)) {
    tried.push({ field: 'reference_number', value: c });
    const hits = await books.searchPurchaseOrders({ reference_number: c });
    const exact = hits.find((p) => String(p.reference_number || '').toLowerCase() === c.toLowerCase());
    if (exact) return { po: exact, strategy: `reference_number=${c}`, tried };
    if (hits.length === 1) return { po: hits[0], strategy: `reference_number~${c}`, tried };
  }

  return { po: null, strategy: null, tried };
}

module.exports = { candidatesFor, resolvePurchaseOrder };
