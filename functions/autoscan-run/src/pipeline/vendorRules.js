'use strict';

/**
 * Per-vendor carriage handling, maintained by finance as two custom fields on the Vendor in Books:
 *   "Carriage Rule"       dropdown  Zero | Fixed | Ignore
 *   "Carriage Tolerance"  decimal   £ (used by Fixed)
 * Fields are found by LABEL, because the API name differs between a sandbox (cf__sb_<org>_carriage_rule)
 * and production (cf_carriage_rule). Default when nothing is set: Zero (the strictest).
 *
 * What the rule governs (lines.js): carriage invoiced at or below the PO's carriage is always accepted; the rule decides
 * about carriage ABOVE the PO — Zero: never, Fixed: up to the tolerance, Ignore: always. With CARRIAGE_BELOW_PO_OK=false
 * the rule applies in both directions.
 */

const RULES = new Set(['Zero', 'Fixed', 'Ignore']);

function customFieldByLabel(entity, label) {
  const want = String(label).trim().toLowerCase();
  const cf = (entity && entity.custom_fields) || [];
  const hit = cf.find((f) => String(f.label || '').trim().toLowerCase() === want);
  if (hit) return hit.value !== undefined && hit.value !== null && hit.value !== '' ? hit.value : null;
  // flat cf_* keys (older API shapes)
  const key = Object.keys(entity || {}).find((k) => /^cf_/.test(k) && !/_formatted$|_unformatted$/.test(k) && k.replace(/^cf_(_sb_\d+_)?/, '').replace(/_/g, ' ') === want);
  return key && entity[key] !== '' ? entity[key] : null;
}

/** Normalised rule for a vendor contact object. */
function vendorCarriageRule(contact, { ruleLabel = 'Carriage Rule', toleranceLabel = 'Carriage Tolerance', defaultRule = 'Zero' } = {}) {
  const raw = customFieldByLabel(contact, ruleLabel);
  let rule = raw ? String(raw).trim() : '';
  rule = rule.charAt(0).toUpperCase() + rule.slice(1).toLowerCase();
  if (!RULES.has(rule)) rule = defaultRule;
  const tol = Number(customFieldByLabel(contact, toleranceLabel));
  return { rule, tolerance: Number.isFinite(tol) && tol >= 0 ? tol : 0, source: raw ? 'vendor' : 'default' };
}

/** Fetch-once-per-run wrapper: ctx.vendorRules caches by vendor id. */
async function getVendorRule(ctx, books, vendorId, opts) {
  const cache = ctx.vendorRules || (ctx.vendorRules = new Map());
  if (cache.has(vendorId)) return cache.get(vendorId);
  let rule;
  try {
    const contact = await books.getContact(vendorId);
    rule = vendorCarriageRule(contact, opts);
  } catch (err) {
    ctx.logger && ctx.logger.warn('vendor.rule_fetch_failed', { vendor_id: vendorId, error: err });
    rule = { rule: (opts && opts.defaultRule) || 'Zero', tolerance: 0, source: 'default' };
  }
  cache.set(vendorId, rule);
  return rule;
}

module.exports = { vendorCarriageRule, customFieldByLabel, getVendorRule };
