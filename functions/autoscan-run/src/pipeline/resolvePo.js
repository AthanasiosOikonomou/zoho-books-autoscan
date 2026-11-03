'use strict';

/**
 * Turn whatever the supplier printed into the Books PO, trying the cheapest
 * and most likely lookups first. Returns { po, strategy, tried }.
 *
 * Candidate generation from a printed reference, e.g.
 *   "IPO/316037"                  → IPO/316037, IPO 316037, IPO-316037, PO-316037, 316037 …
 *   "PO-00235"                    → PO-00235, 00235, 235 …
 *   "Order No. IPO 317792-Harlow" → IPO 317792, IPO/317792, IPO-317792, PO-317792, 317792 …
 *   "235"                         → PO-00235, 235
 *
 * Two groups are produced:
 *   numberCandidates    → tried against purchaseorder_number (exact)
 *   referenceCandidates → tried against reference_number (exact, then single partial hit)
 */
function candidatesFor(ref, { poPrefix = 'PO-', poPadWidth = 5, legacyPrefixes = ['IPO/', 'IPO ', 'IPO-'] } = {}) {
  const out = [];
  const push = (v) => { v = String(v || '').trim(); if (v && !out.includes(v)) out.push(v); };

  const raw = String(ref || '').trim();
  if (!raw) return out;
  push(raw);

  // legacy token anywhere in the text: "IPO 317792", "IPO/316037", "ipo-123456"
  const legacyStems = [...new Set(legacyPrefixes.map((p) => p.replace(/[\s/\-]+$/, '')).filter(Boolean))];
  if (legacyStems.length) {
    const re = new RegExp(`\\b(${legacyStems.map(escapeRe).join('|')})[\\s/\\-]*(\\d{4,})`, 'i');
    const m = raw.match(re);
    if (m) {
      const stem = m[1].toUpperCase();
      const d = m[2];
      push(`${stem}/${d}`); push(`${stem} ${d}`); push(`${stem}-${d}`); push(`${stem}${d}`);
      push(`${poPrefix}${d}`); push(d);
    }
  }

  // Books-style token anywhere: "PO-00235", "po 235"
  {
    const re = new RegExp(`\\b${escapeRe(poPrefix.replace(/[\s/\-]+$/, ''))}[\\s/\\-]*(\\d{3,})`, 'i');
    const m = raw.match(re);
    if (m) { const d = m[1]; push(`${poPrefix}${d}`); push(`${poPrefix}${d.padStart(poPadWidth, '0')}`); push(`${poPrefix}${d.replace(/^0+/, '')}`); push(d); push(d.replace(/^0+/, '')); }
  }

  // strip a leading legacy prefix
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

  if (core.toUpperCase().startsWith(poPrefix.toUpperCase())) push(core.slice(poPrefix.length));
  return out;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * @param {object} books   Books client
 * @param {string} ref     printed PO reference
 * @param {object} opts    matching config (+ maxLookups, default 8)
 */
async function resolvePurchaseOrder(books, ref, opts = {}) {
  const tried = [];
  const cands = candidatesFor(ref, opts);
  const maxLookups = opts.maxLookups || 8;

  // 1) exact purchaseorder_number — Books-looking candidates first, bare digits last
  const numberCands = cands.filter((c) => !/\s/.test(c)).slice(0, maxLookups);
  for (const c of numberCands) {
    tried.push({ field: 'purchaseorder_number', value: c });
    const hits = await books.searchPurchaseOrders({ purchaseorder_number: c });
    const exact = hits.find((p) => String(p.purchaseorder_number).toLowerCase() === c.toLowerCase());
    if (exact) return { po: exact, strategy: `purchaseorder_number=${c}`, tried };
  }

  // 2) reference_number — exact match wins; a single partial hit is accepted
  const refCands = cands.filter((c) => !/^\d{1,3}$/.test(c)).slice(0, maxLookups);
  for (const c of refCands) {
    tried.push({ field: 'reference_number', value: c });
    const hits = await books.searchPurchaseOrders({ reference_number: c });
    const exact = hits.find((p) => String(p.reference_number || '').toLowerCase() === c.toLowerCase());
    if (exact) return { po: exact, strategy: `reference_number=${c}`, tried };
    if (hits.length === 1) return { po: hits[0], strategy: `reference_number~${c}`, tried };
  }

  return { po: null, strategy: null, tried };
}

module.exports = { candidatesFor, resolvePurchaseOrder };
