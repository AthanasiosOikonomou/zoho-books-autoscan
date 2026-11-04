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

    const summary = await runAutoscan({ config, books, extractor, store, mailer, logger, deadlineAt });
    logger.info('job.finished', { run_id: summary.run_id, status: summary.status, skipped: !!summary.skipped });
    context.closeWithSuccess();
  } catch (err) {
    logger.error('job.failed', { error: err });
    context.closeWithFailure();
  }
};
