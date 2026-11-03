'use strict';

const { diff, round2 } = require('../util/money');

/**
 * Phase 1 matching: invoice gross vs PO total, with an optional second chance
 * against the PO's *remaining* value (PO total minus bills already raised
 * against it) so the closing invoice of a partially billed PO still matches.
 *
 * Pure function — no I/O — so it is fully unit-testable.
 *
 * @returns {{ ok:boolean, basis:'po_total'|'remaining'|null, difference:number, invoiceGross:number, poTotal:number, billedTotal:number, remaining:number }}
 */
function matchTotals({ invoiceGross, poTotal, billedTotal = 0, tolerance = 0.02, compareAgainstRemaining = true }) {
  const inv = Number(invoiceGross);
  const po = Number(poTotal);
  const billed = Number(billedTotal) || 0;
  const remaining = round2(po - billed);

  if (!Number.isFinite(inv) || !Number.isFinite(po)) {
    return { ok: false, basis: null, difference: NaN, invoiceGross: inv, poTotal: po, billedTotal: billed, remaining };
  }

  const dTotal = diff(inv, po);
  if (dTotal <= tolerance) {
    return { ok: true, basis: 'po_total', difference: dTotal, invoiceGross: inv, poTotal: po, billedTotal: billed, remaining };
  }
  if (compareAgainstRemaining && billed > 0 && remaining > 0) {
    const dRem = diff(inv, remaining);
    if (dRem <= tolerance) {
      return { ok: true, basis: 'remaining', difference: dRem, invoiceGross: inv, poTotal: po, billedTotal: billed, remaining };
    }
  }
  return { ok: false, basis: null, difference: dTotal, invoiceGross: inv, poTotal: po, billedTotal: billed, remaining };
}

/** Sum of bill totals already linked to a PO (used for the "remaining" basis). */
function sumBilled(bills) {
  return round2((bills || []).reduce((s, b) => s + (Number(b.total) || 0), 0));
}

module.exports = { matchTotals, sumBilled };
