#!/usr/bin/env node
'use strict';

/**
 * Generate functions/autoscan-run/catalyst-config.json from .env.
 *
 * Why: `catalyst deploy` replaces the function's environment variables with
 * exactly what is in catalyst-config.json (Console-set values are wiped).
 * So the deploy file must carry the real values — and therefore must never be
 * committed. It is git-ignored; this script rebuilds it before every deploy.
 *
 *   npm run catalyst-config            → writes the file, prints the variable NAMES only
 *   npm run catalyst-config -- --check → prints what would be written (names), writes nothing
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const FN_DIR = path.join(__dirname, '..', 'functions', 'autoscan-run');
const EXAMPLE = path.join(FN_DIR, 'catalyst-config.example.json');
const TARGET = path.join(FN_DIR, 'catalyst-config.json');

// Variables that belong to the deployed function. Local-only ones are excluded on purpose.
const DEPLOY_VARS = [
  'BOOKS_DC', 'BOOKS_ORG_ID', 'BOOKS_CLIENT_ID', 'BOOKS_CLIENT_SECRET', 'BOOKS_REFRESH_TOKEN', 'BOOKS_RATE_PER_MIN', 'BOOKS_MAX_RETRIES', 'BOOKS_INBOX_PAGE_SIZE',
  'ANTHROPIC_API_KEY', 'CLAUDE_MODEL', 'CLAUDE_FALLBACK_MODEL', 'CLAUDE_FALLBACK_BELOW_CONFIDENCE', 'CLAUDE_MAX_OUTPUT_TOKENS', 'CLAUDE_TIMEOUT_MS', 'CLAUDE_MAX_RETRIES', 'CLAUDE_PAGE_CAP', 'CLAUDE_PROMPT_CACHE',
  'TOTAL_TOLERANCE', 'BILL_ADJUST_TO_INVOICE', 'CONFIDENCE_THRESHOLD', 'PO_PREFIX', 'PO_PAD_WIDTH', 'PO_EXAMPLE', 'PO_LEGACY_PREFIXES', 'MATCH_AGAINST_REMAINING', 'PHASE2_ENABLED',
  'LINE_PRICE_TOLERANCE_PCT', 'LINE_PRICE_TOLERANCE_UP_PCT', 'LINE_PRICE_TOLERANCE_ABS', 'SUPPLIER_REF_LABEL', 'CARRIAGE_ITEM_ID', 'CARRIAGE_ACCOUNT_ID', 'CARRIAGE_RULE_LABEL', 'CARRIAGE_TOLERANCE_LABEL', 'DEFAULT_CARRIAGE_RULE',
  'CARRIAGE_BELOW_PO_OK', 'SURCHARGE_IN_PRICE', 'LINE_VALUE_FALLBACK', 'PACK_ROUNDING_PER_ITEM', 'KIT_RULE',
  'DRY_RUN', 'MAX_NEW_PER_RUN', 'SCAN_SINCE', 'MAX_RETRY_PER_RUN', 'CONCURRENCY', 'RETRY_AFTER_HOURS', 'RETRY_TRANSIENT_AFTER_MINUTES', 'RETRY_SLACK_MINUTES', 'RECHECK_HELD_BEFORE', 'MAX_ATTEMPTS', 'TIME_BUDGET_RATIO', 'LOCK_STALE_MINUTES',
  'REPORT_TO', 'REPORT_DEV_COPY', 'REPORT_FROM', 'REPORT_SUBJECT_PREFIX', 'BOOKS_APP_BASE', 'DAILY_REPORT_HOUR', 'REPORT_TIMEZONE', 'REPORT_PER_RUN',
  'MAIL_TRANSPORT', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS',
  'LOG_LEVEL',
];
const REQUIRED = ['BOOKS_ORG_ID', 'BOOKS_CLIENT_ID', 'BOOKS_CLIENT_SECRET', 'BOOKS_REFRESH_TOKEN', 'ANTHROPIC_API_KEY'];
// Mail: log needs nothing; smtp needs the mailbox; catalyst needs a sender verified (with its domain) in the Console.
const MAIL_REQUIRED = { log: [], smtp: ['REPORT_TO', 'SMTP_USER', 'SMTP_PASS'], catalyst: ['REPORT_TO', 'REPORT_FROM'] }[(process.env.MAIL_TRANSPORT || 'log').toLowerCase()] || [];

const check = process.argv.includes('--check');
const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
const env = {};
for (const k of DEPLOY_VARS) if (process.env[k] !== undefined && process.env[k] !== '') env[k] = String(process.env[k]);
// Production profile: the same file is deployed to both Catalyst environments; in Production the function reads
// PROD_<NAME> first (see src/config.js). Any PROD_ counterpart of a deployable variable travels with the deploy.
const prodVars = [];
for (const k of DEPLOY_VARS) {
  const pk = `PROD_${k}`;
  if (process.env[pk] !== undefined && process.env[pk] !== '') { env[pk] = String(process.env[pk]); prodVars.push(pk); }
}
const missing = [...REQUIRED, ...MAIL_REQUIRED].filter((k) => !env[k]);
if (missing.length) { console.error(`Missing in .env: ${missing.join(', ')}`); process.exit(2); }
if (env.DRY_RUN !== 'false') console.log('Note: DRY_RUN is not "false" — the deployed function will run in dry-run mode (correct until UAT sign-off).');

const prodMissing = ['PROD_BOOKS_ORG_ID', 'PROD_SCAN_SINCE'].filter((k) => !env[k]);
if (!prodVars.length) console.log('Note: no PROD_ variables in .env — fine while only the Development environment is used.');
else if (prodMissing.length) console.log(`Note: production profile incomplete (${prodMissing.join(', ')}) — the function refuses to run in the Production environment until they are set.`);
else if (env.PROD_DRY_RUN !== 'false') console.log('Note: PROD_DRY_RUN is not "false" — Production will run in dry-run mode (correct until UAT sign-off).');
else console.log('WARNING: PROD_DRY_RUN=false — the Production environment will create bills in the production organisation.');

// One-shot re-check after a deploy: every held document last checked before the deploy is re-checked on the next run,
// so a code or rule change applies at once. Stamped with now unless .env sets a value; RECHECK_HELD_BEFORE=off disables.
const recheck = String(process.env.RECHECK_HELD_BEFORE || '').trim();
if (recheck.toLowerCase() === 'off') delete env.RECHECK_HELD_BEFORE;
else if (!recheck) env.RECHECK_HELD_BEFORE = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
console.log(env.RECHECK_HELD_BEFORE
  ? `RECHECK_HELD_BEFORE=${env.RECHECK_HELD_BEFORE} — every held document is re-checked once on the next run after this deploy.`
  : 'RECHECK_HELD_BEFORE=off — held documents wait for their normal retry window.');

const out = { ...example, deployment: { ...example.deployment, env_variables: env } };
console.log(`${check ? 'Would write' : 'Writing'} ${path.relative(process.cwd(), TARGET)} with ${Object.keys(env).length} variables: ${Object.keys(env).join(', ')}`);
if (!check) fs.writeFileSync(TARGET, JSON.stringify(out, null, 2) + '\n');
