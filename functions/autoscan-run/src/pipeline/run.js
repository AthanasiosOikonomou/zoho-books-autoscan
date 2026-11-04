'use strict';

const { errorMessage } = require('../logger');

const { STATUS } = require('../state/store');
const { processDocument } = require('./processDocument');
const { mapWithConcurrency } = require('../util/limiter');
const { newRunId } = require('../util/hash');
const { buildReport } = require('../report/email');

/**
 * One AutoScan run:
 *   lock → config → scan inbox → pass A (new) → pass B (retries) → report → close
 *
 * @param {object} deps { config, books, extractor, store, mailer, logger, now?, deadlineAt? }
 * @returns {object} run summary
 */
async function runAutoscan(deps) {
  const { config, books, extractor, store, mailer } = deps;
  const now = deps.now || (() => new Date());
  const runId = newRunId(now());
  const logger = deps.logger.child({ runId });
  const startedAt = now();
  const deadlineAt = deps.deadlineAt || (startedAt.getTime() + 10 * 60000);
  const shouldStop = () => now().getTime() >= deadlineAt;

  // 0. lock
  const active = await store.getActiveRun({ staleMinutes: config.run.lockStaleMinutes, now: startedAt.getTime() });
  if (active) {
    logger.warn('run.skipped_active_run', { active_run: active.run_id });
    return { run_id: runId, skipped: true, reason: 'active_run', active_run: active.run_id };
  }

  const run = await store.beginRun({ run_id: runId, started: startedAt.toISOString(), status: 'RUNNING', notes: config.run.dryRun ? 'dry-run' : '' });
  const results = [];
  let stoppedEarly = null;

  try {
    // 1. config: payment terms once per run
    const terms = await books.getPaymentTerms();

    // 2. scan inbox
    const inbox = (await books.listAllInboxDocuments()).filter((d) => !(Array.isArray(d.transactions) && d.transactions.length > 0));
    const ids = inbox.map((d) => String(d.document_id));
    const known = await store.getByDocumentIds(ids);
    const byId = new Map(inbox.map((d) => [String(d.document_id), d]));

    const newDocs = inbox
      .filter((d) => !known.has(String(d.document_id)))
      .sort((a, b) => String(a.created_time || '').localeCompare(String(b.created_time || '')))
      .slice(0, config.run.maxNewPerRun);

    const retryRecords = (await store.listRetryCandidates({
      olderThan: new Date(startedAt.getTime() - config.run.retryAfterHours * 3600000),
      transientOlderThan: new Date(startedAt.getTime() - (config.run.retryTransientAfterMinutes || 0) * 60000),
      staleOlderThan: new Date(startedAt.getTime() - config.run.lockStaleMinutes * 60000),
      maxAttempts: config.run.maxAttempts,
      limit: config.run.maxRetryPerRun,
    })).filter((r) => byId.has(String(r.document_id))); // must still be in the inbox

    logger.info('run.scan', { inbox: inbox.length, known: known.size, new: newDocs.length, retry: retryRecords.length, dry_run: config.run.dryRun });

    const ctx = { config, books, extractor, store, logger, terms, runId, now, claims: new Map() };

    // 3. pass A — new documents first, always
    const passA = await mapWithConcurrency(newDocs, config.run.concurrency, (d) => processDocument(ctx, d, null), { shouldStop });
    collect(results, passA, newDocs, 'new');
    if (passA.stopped) stoppedEarly = 'time_budget';

    // 4. pass B — retries, only if there is budget left
    if (!stoppedEarly) {
      const passB = await mapWithConcurrency(retryRecords, config.run.concurrency, (r) => processDocument(ctx, byId.get(String(r.document_id)), r), { shouldStop });
      collect(results, passB, retryRecords, 'retry');
      if (passB.stopped) stoppedEarly = 'time_budget';
    }
  } catch (err) {
    if (err && err.code === 'BOOKS_DAILY_LIMIT') {
      stoppedEarly = 'books_daily_limit';
      logger.warn('run.stopped_daily_limit');
    } else {
      logger.error('run.failed', { error: err });
      run.status = 'FAILED';
      run.notes = `${run.notes || ''} ${err && err.message}`.trim();
    }
  }

  // 5. report
  const summary = summarise(results, books.stats);
  const finishedAt = now();
  Object.assign(run, {
    finished: finishedAt.toISOString(),
    status: run.status === 'FAILED' ? 'FAILED' : 'DONE',
    docs_seen: summary.docs_seen,
    new_count: summary.new_count,
    billed: summary.billed,
    exceptions: summary.exceptions,
    retried: summary.retried,
    errors: summary.errors,
    books_calls: books.stats ? books.stats.calls : 0,
    claude_calls: summary.claude_calls,
    tokens_in: summary.tokens_in,
    tokens_out: summary.tokens_out,
    est_cost_usd: Number(summary.est_cost_usd.toFixed(4)),
    report_sent: false,
    notes: [run.notes, stoppedEarly ? `stopped:${stoppedEarly}` : ''].filter(Boolean).join(' '),
  });

  if (results.length > 0 || run.status === 'FAILED') {
    const report = buildReport({ run, results, config, stoppedEarly });
    try {
      await mailer.send(report);
      run.report_sent = true;
    } catch (err) {
      logger.error('report.send_failed', { error: err });
    }
  }

  await store.endRun(run);
  logger.info('run.done', { ...summary, status: run.status, stopped: stoppedEarly, ms: finishedAt - startedAt });
  return { ...run, results };
}

function collect(results, pass, items, mode) {
  pass.results.forEach((r, i) => {
    if (!r) return;
    if (r.ok) results.push(r.value);
    else results.push({ document_id: String(items[i].document_id), file_name: items[i].file_name, mode, status: STATUS.EXCEPTION, reason_code: 'AI_ERROR', reason_text: errorMessage(r.error), links: {} });
  });
}

function summarise(results, stats) {
  const s = { docs_seen: results.length, new_count: 0, retried: 0, billed: 0, would_bill: 0, exceptions: 0, duplicates: 0, errors: 0, claude_calls: 0, tokens_in: 0, tokens_out: 0, est_cost_usd: 0 };
  for (const r of results) {
    if (r.mode === 'new') s.new_count++; else s.retried++;
    if (r.status === STATUS.BILLED) s.billed++;
    else if (r.status === STATUS.WOULD_BILL) s.would_bill++;
    else if (r.status === STATUS.DUPLICATE) s.duplicates++;
    else s.exceptions++;
    if (r.reason_code === 'AI_ERROR' || r.reason_code === 'BOOKS_ERROR') s.errors++;
    if (r.ai) { s.claude_calls++; s.tokens_in += r.ai.tokens_in || 0; s.tokens_out += r.ai.tokens_out || 0; }
    s.est_cost_usd += r.cost_usd || 0;
  }
  s.books_calls = stats ? stats.calls : 0;
  return s;
}

module.exports = { runAutoscan, summarise };
