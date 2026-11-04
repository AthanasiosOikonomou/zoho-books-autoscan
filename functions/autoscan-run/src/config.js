'use strict';

/**
 * Central configuration. Every tunable lives here and comes from environment
 * variables (Catalyst env vars in production, .env locally). No literals
 * elsewhere in the code base.
 */

function bool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
function num(v, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function list(v, def = []) {
  if (!v) return def;
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

function loadConfig(env = process.env) {
  const cfg = {
    env: env.AUTOSCAN_ENV || 'development',

    // --- Zoho Books ---------------------------------------------------------
    books: {
      dc: env.BOOKS_DC || 'eu', // eu | com | in | com.au ...
      orgId: env.BOOKS_ORG_ID || '',
      clientId: env.BOOKS_CLIENT_ID || '',
      clientSecret: env.BOOKS_CLIENT_SECRET || '',
      refreshToken: env.BOOKS_REFRESH_TOKEN || '',
      ratePerMin: num(env.BOOKS_RATE_PER_MIN, 80), // org cap is 100/min
      maxRetries: num(env.BOOKS_MAX_RETRIES, 3),
      inboxPageSize: num(env.BOOKS_INBOX_PAGE_SIZE, 200),
    },

    // --- Claude -------------------------------------------------------------
    claude: {
      apiKey: env.ANTHROPIC_API_KEY || '',
      // Set to the current Haiku id from https://platform.claude.com/docs/en/about-claude/models
      model: env.CLAUDE_MODEL || 'claude-haiku-5-5',
      fallbackModel: env.CLAUDE_FALLBACK_MODEL || '', // e.g. a Sonnet id; '' = disabled
      fallbackBelowConfidence: num(env.CLAUDE_FALLBACK_BELOW_CONFIDENCE, 0), // 0 = never
      maxOutputTokens: num(env.CLAUDE_MAX_OUTPUT_TOKENS, 1200),
      timeoutMs: num(env.CLAUDE_TIMEOUT_MS, 60000),
      maxRetries: num(env.CLAUDE_MAX_RETRIES, 2),
      pageCap: num(env.CLAUDE_PAGE_CAP, 6),
      promptCache: bool(env.CLAUDE_PROMPT_CACHE, true),
    },

    // --- Matching -----------------------------------------------------------
    matching: {
      totalTolerance: num(env.TOTAL_TOLERANCE, 0.02), // GBP
      confidenceThreshold: num(env.CONFIDENCE_THRESHOLD, 0.75),
      poPrefix: env.PO_PREFIX || 'PO-',
      poPadWidth: num(env.PO_PAD_WIDTH, 5), // PO-00235
      legacyPrefixes: list(env.PO_LEGACY_PREFIXES, ['IPO/', 'IPO ', 'IPO-']),
      compareAgainstRemaining: bool(env.MATCH_AGAINST_REMAINING, true),
      phase2Enabled: bool(env.PHASE2_ENABLED, false),
    },

    // --- Queue / run behaviour ---------------------------------------------
    run: {
      dryRun: bool(env.DRY_RUN, true), // SAFE DEFAULT: never writes to Books unless explicitly false
      maxNewPerRun: num(env.MAX_NEW_PER_RUN, 40),
      maxRetryPerRun: num(env.MAX_RETRY_PER_RUN, 20),
      concurrency: num(env.CONCURRENCY, 3),
      retryAfterHours: num(env.RETRY_AFTER_HOURS, 12), // human-fixable exceptions (PO missing, total mismatch…)
      retryTransientAfterMinutes: num(env.RETRY_TRANSIENT_AFTER_MINUTES, 0), // AI/Books/attach errors: 0 = next run
      maxAttempts: num(env.MAX_ATTEMPTS, 5),
      timeBudgetRatio: num(env.TIME_BUDGET_RATIO, 0.7),
      lockStaleMinutes: num(env.LOCK_STALE_MINUTES, 15),
    },

    // --- Report -------------------------------------------------------------
    report: {
      to: list(env.REPORT_TO, []),
      devCopy: list(env.REPORT_DEV_COPY, []),
      from: env.REPORT_FROM || env.SMTP_USER || '',
      subjectPrefix: env.REPORT_SUBJECT_PREFIX || 'AutoScan',
      // log = no email, the report text goes to the function log | smtp = any SMTP mailbox | catalyst = Catalyst Mail (domain verified)
      transport: String(env.MAIL_TRANSPORT || 'log').toLowerCase(),
      smtp: {
        host: env.SMTP_HOST || 'smtp.zoho.eu',
        port: num(env.SMTP_PORT, 465),
        secure: bool(env.SMTP_SECURE, true), // true = implicit TLS (465); false = STARTTLS (587)
        user: env.SMTP_USER || '',
        pass: env.SMTP_PASS || '',
      },
      booksAppBase: env.BOOKS_APP_BASE || `https://books.zoho.${env.BOOKS_DC || 'eu'}/app/${env.BOOKS_ORG_ID || ''}`,
    },

    // --- Local only ---------------------------------------------------------
    local: {
      stateFile: env.STATE_FILE || './.autoscan-state.json',
      outDir: env.OUT_DIR || './out',
    },
  };

  return cfg;
}

function assertRuntimeConfig(cfg) {
  const missing = [];
  if (!cfg.books.orgId) missing.push('BOOKS_ORG_ID');
  if (!cfg.books.clientId) missing.push('BOOKS_CLIENT_ID');
  if (!cfg.books.clientSecret) missing.push('BOOKS_CLIENT_SECRET');
  if (!cfg.books.refreshToken) missing.push('BOOKS_REFRESH_TOKEN');
  if (!cfg.claude.apiKey) missing.push('ANTHROPIC_API_KEY');
  if (!['log', 'smtp', 'catalyst'].includes(cfg.report.transport)) {
    throw new Error(`MAIL_TRANSPORT must be "log", "smtp" or "catalyst" (got "${cfg.report.transport}")`);
  }
  if (cfg.report.transport === 'smtp') {
    if (!cfg.report.smtp.user) missing.push('SMTP_USER');
    if (!cfg.report.smtp.pass) missing.push('SMTP_PASS');
  }
  if (missing.length) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
  return cfg;
}

module.exports = { loadConfig, assertRuntimeConfig };
