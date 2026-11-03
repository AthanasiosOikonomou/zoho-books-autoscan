'use strict';

/** Parse "1,259.63", "£1,200.00", "GBP 75.19", 1259.63 → 1259.63 (number) or null. */
function parseAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? round2(v) : null;
  const cleaned = String(v).replace(/[^0-9.,-]/g, '').replace(/,/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? round2(n) : null;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function diff(a, b) {
  return round2(Math.abs(a - b));
}

module.exports = { parseAmount, round2, diff };
