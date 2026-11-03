#!/usr/bin/env node
'use strict';

/**
 * Run one AutoScan cycle from your machine against the Books org in .env.
 *
 *   node scripts/local-run.js            → DRY-RUN (default, never writes to Books)
 *   node scripts/local-run.js --live     → writes to Books; ALSO requires DRY_RUN=false in .env
 *   node scripts/local-run.js --limit 5  → cap new documents this run
 *   node scripts/local-run.js --retry-now → re-check EXCEPTION docs now instead of after RETRY_AFTER_HOURS (no AI cost)
 *   node scripts/local-run.js --reset-state → forget everything seen (next run re-extracts: costs AI calls)
 *
 * State is kept in STATE_FILE (default ./.autoscan-state.json) so repeated
 * local runs behave exactly like production (no re-reading of files).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Anthropic = require('@anthropic-ai/sdk');
const fn = (p) => require(path.join(__dirname, '..', 'functions', 'autoscan-run', 'src', p));
const { loadConfig, assertRuntimeConfig } = fn('config');
const { createLogger } = fn('logger');
const { createTokenProvider } = fn('books/oauth');
const { createBooksClient } = fn('books/client');
const { createExtractor } = fn('claude/extractor');
const { JsonFileStore } = fn('state/store');
const { createFileMailer } = fn('report/mailers');
const { runAutoscan } = fn('pipeline/run');

(async () => {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : null;
  const retryNow = args.includes('--retry-now');
  const resetState = args.includes('--reset-state');

  const config = assertRuntimeConfig(loadConfig(process.env));
  if (live && config.run.dryRun) {
    console.error('Refusing --live: DRY_RUN is not false in .env. Set DRY_RUN=false AND pass --live to write to Books.');
    process.exit(2);
  }
  if (!live) config.run.dryRun = true; // belt and braces
  if (limit) config.run.maxNewPerRun = limit;
  if (retryNow) { config.run.retryAfterHours = 0; config.run.maxAttempts = 999; }
  if (resetState) { try { require('fs').unlinkSync(path.resolve(config.local.stateFile)); console.log('State file removed.'); } catch { /* none */ } }

  const logger = createLogger({ level: process.env.LOG_LEVEL || 'info' });
  const tokenProvider = createTokenProvider(config.books);
  const books = createBooksClient({ config: config.books, tokenProvider, logger });
  const extractor = createExtractor({ client: new Anthropic({ apiKey: config.claude.apiKey }), config: config.claude, logger });
  const store = new JsonFileStore({ filePath: path.resolve(config.local.stateFile) });
  const mailer = createFileMailer({ outDir: path.resolve(config.local.outDir), logger });

  console.log(`AutoScan local run — org ${config.books.orgId} — ${config.run.dryRun ? 'DRY-RUN' : 'LIVE WRITES'} — model ${config.claude.model}`);
  const summary = await runAutoscan({ config, books, extractor, store, mailer, logger, deadlineAt: Date.now() + 10 * 60000 });
  if (summary.skipped) { console.log('Skipped:', summary.reason); return; }
  console.log(JSON.stringify({ run_id: summary.run_id, status: summary.status, new: summary.new_count, retried: summary.retried, billed: summary.billed, exceptions: summary.exceptions, books_calls: summary.books_calls, claude_calls: summary.claude_calls, est_cost_usd: summary.est_cost_usd, notes: summary.notes }, null, 2));
})().catch((err) => { console.error(err); process.exit(1); });
