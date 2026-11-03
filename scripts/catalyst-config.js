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
  'AUTOSCAN_ENV',
  'BOOKS_DC', 'BOOKS_ORG_ID', 'BOOKS_CLIENT_ID', 'BOOKS_CLIENT_SECRET', 'BOOKS_REFRESH_TOKEN', 'BOOKS_RATE_PER_MIN', 'BOOKS_MAX_RETRIES', 'BOOKS_INBOX_PAGE_SIZE',
  'ANTHROPIC_API_KEY', 'CLAUDE_MODEL', 'CLAUDE_FALLBACK_MODEL', 'CLAUDE_FALLBACK_BELOW_CONFIDENCE', 'CLAUDE_MAX_OUTPUT_TOKENS', 'CLAUDE_TIMEOUT_MS', 'CLAUDE_MAX_RETRIES', 'CLAUDE_PAGE_CAP', 'CLAUDE_PROMPT_CACHE',
  'TOTAL_TOLERANCE', 'CONFIDENCE_THRESHOLD', 'PO_PREFIX', 'PO_PAD_WIDTH', 'PO_LEGACY_PREFIXES', 'MATCH_AGAINST_REMAINING', 'PHASE2_ENABLED',
  'DRY_RUN', 'MAX_NEW_PER_RUN', 'MAX_RETRY_PER_RUN', 'CONCURRENCY', 'RETRY_AFTER_HOURS', 'MAX_ATTEMPTS', 'TIME_BUDGET_RATIO', 'LOCK_STALE_MINUTES',
  'REPORT_TO', 'REPORT_DEV_COPY', 'REPORT_FROM', 'REPORT_SUBJECT_PREFIX', 'BOOKS_APP_BASE',
  'LOG_LEVEL',
];
const REQUIRED = ['BOOKS_ORG_ID', 'BOOKS_CLIENT_ID', 'BOOKS_CLIENT_SECRET', 'BOOKS_REFRESH_TOKEN', 'ANTHROPIC_API_KEY', 'REPORT_TO', 'REPORT_FROM'];

const check = process.argv.includes('--check');
const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
const env = {};
for (const k of DEPLOY_VARS) if (process.env[k] !== undefined && process.env[k] !== '') env[k] = String(process.env[k]);
const missing = REQUIRED.filter((k) => !env[k]);
if (missing.length) { console.error(`Missing in .env: ${missing.join(', ')}`); process.exit(2); }
if (env.DRY_RUN !== 'false') console.log('Note: DRY_RUN is not "false" — the deployed function will run in dry-run mode (correct until UAT sign-off).');

const out = { ...example, deployment: { ...example.deployment, env_variables: env } };
console.log(`${check ? 'Would write' : 'Writing'} ${path.relative(process.cwd(), TARGET)} with ${Object.keys(env).length} variables: ${Object.keys(env).join(', ')}`);
if (!check) fs.writeFileSync(TARGET, JSON.stringify(out, null, 2) + '\n');
