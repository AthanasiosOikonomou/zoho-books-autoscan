'use strict';

/**
 * Catalyst Job function entry point (type: job, triggered by Cron).
 * Wires production dependencies and runs one AutoScan cycle.
 */
const catalyst = require('zcatalyst-sdk-node');
const Anthropic = require('@anthropic-ai/sdk');
const { loadConfig, assertRuntimeConfig } = require('./config');
const { createLogger } = require('./logger');
const { createTokenProvider } = require('./books/oauth');
const { createBooksClient } = require('./books/client');
const { createExtractor } = require('./claude/extractor');
const { CatalystStore } = require('./state/store');
const { createMailer } = require('./report/mailers');
const { runAutoscan } = require('./pipeline/run');
const { sendDailyReportIfDue } = require('./report/dailyTrigger');

module.exports = async (jobRequest, context) => {
  const logger = createLogger({ level: process.env.LOG_LEVEL || 'info' });
  try {
    const app = catalyst.initialize(context, { scope: 'admin' });
    const config = assertRuntimeConfig(loadConfig(process.env));

    const maxMs = parseInt(context.getMaxExecutionTimeMs(), 10) || 900000;
    const deadlineAt = Date.now() + Math.floor(maxMs * config.run.timeBudgetRatio);

    const tokenProvider = createTokenProvider(config.books);
    const books = createBooksClient({ config: config.books, tokenProvider, logger });
    const extractor = createExtractor({ client: new Anthropic({ apiKey: config.claude.apiKey }), config: config.claude, poExample: config.matching.poExample, logger });
    const store = new CatalystStore({ app, logger });
    const mailer = createMailer({ config, app, logger });

    const params = jobParams(jobRequest);
    if (String(params.mode || '').toLowerCase() === 'daily_report') {
      // Submitted by hand or by a dedicated cron: { "mode": "daily_report", "force": "true" } re-sends even if today's digest went out.
      const r = await sendDailyReportIfDue({ config, store, mailer, logger, explicit: true, force: ['true', '1', 'yes'].includes(String(params.force || '').toLowerCase()) });
      logger.info('job.finished', { mode: 'daily_report', sent: r.sent, reason: r.reason || null, counts: r.counts || null });
      context.closeWithSuccess();
      return;
    }

    const summary = await runAutoscan({ config, books, extractor, store, mailer, logger, deadlineAt });
    logger.info('job.finished', { run_id: summary.run_id, status: summary.status, skipped: !!summary.skipped });
    context.closeWithSuccess();
  } catch (err) {
    logger.error('job.failed', { error: err });
    context.closeWithFailure();
  }
};

/** Job params as a plain object, whatever shape the SDK hands over (getAllJobParams(), plain object, or nothing). */
function jobParams(jobRequest) {
  try {
    if (jobRequest && typeof jobRequest.getAllJobParams === 'function') return jobRequest.getAllJobParams() || {};
    if (jobRequest && typeof jobRequest === 'object') return jobRequest.job_params || jobRequest.params || jobRequest;
  } catch (_) { /* ignore */ }
  return {};
}
