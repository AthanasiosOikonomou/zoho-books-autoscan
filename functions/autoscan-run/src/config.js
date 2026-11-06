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
      maxOutputTokens: num(env.CLAUDE_MAX_OUTPUT_TOKENS, 6000), // a 16-line invoice needs ~1,500; only used tokens are billed
      timeoutMs: num(env.CLAUDE_TIMEOUT_MS, 60000),
      maxRetries: num(env.CLAUDE_MAX_RETRIES, 2),
      pageCap: num(env.CLAUDE_PAGE_CAP, 6),
      promptCache: bool(env.CLAUDE_PROMPT_CACHE, true),
    },

    // --- Matching -----------------------------------------------------------
    matching: {
      totalTolerance: num(env.TOTAL_TOLERANCE, 1.0), // GBP — client rule: £1 on the invoice total
      billAdjustToInvoice: bool(env.BILL_ADJUST_TO_INVOICE, true), // the bill carries the invoice total, not the PO's: difference goes into Books' `adjustment`
      confidenceThreshold: num(env.CONFIDENCE_THRESHOLD, 0.75),
      poPrefix: env.PO_PREFIX || 'PO-',
      poPadWidth: num(env.PO_PAD_WIDTH, 5), // PO-00235
      legacyPrefixes: list(env.PO_LEGACY_PREFIXES, ['IPO/', 'IPO ', 'IPO-']),
      poExample: env.PO_EXAMPLE || `${env.PO_PREFIX || 'PO-'}${'235'.padStart(num(env.PO_PAD_WIDTH, 5), '0')}`, // shown to the model as "the Books format" (production: PR-00123)
      compareAgainstRemaining: bool(env.MATCH_AGAINST_REMAINING, true),
      phase2Enabled: bool(env.PHASE2_ENABLED, false),
      // --- Phase 2: line-level matching
      // Client rule (6 Nov 2026): a unit price BELOW the PO by up to 5% is billed at the invoice price; any price ABOVE the
      // PO goes to review. Both limits are per line, as % of the PO unit price; the GBP floor only absorbs penny rounding.
      linePriceTolerancePct: num(env.LINE_PRICE_TOLERANCE_PCT, 5), // allowed % below the PO unit price
      linePriceToleranceUpPct: num(env.LINE_PRICE_TOLERANCE_UP_PCT, 0), // allowed % above the PO unit price (0 = any increase → review)
      linePriceToleranceAbs: num(env.LINE_PRICE_TOLERANCE_ABS, 0.01), // GBP rounding guard, both directions
      supplierRefLabel: env.SUPPLIER_REF_LABEL || 'Supplier Reference', // item custom field printed on the PO
      carriageItemId: env.CARRIAGE_ITEM_ID || '', // Books item used for carriage on bills when the PO has no carriage line (else: first line's account)
      carriageRuleLabel: env.CARRIAGE_RULE_LABEL || 'Carriage Rule', // vendor custom fields
      carriageToleranceLabel: env.CARRIAGE_TOLERANCE_LABEL || 'Carriage Tolerance',
      defaultCarriageRule: env.DEFAULT_CARRIAGE_RULE || 'Zero',
    },

    // --- Queue / run behaviour ---------------------------------------------
    run: {
      dryRun: bool(env.DRY_RUN, true), // SAFE DEFAULT: never writes to Books unless explicitly false
      maxNewPerRun: num(env.MAX_NEW_PER_RUN, 40),
      // Documents created in Books before this date are never read, recorded or reported (client: the historical
      // backlog stays untouched). ISO date or date-time; unset = every inbox document is eligible (sandbox).
      scanSince: env.SCAN_SINCE ? String(env.SCAN_SINCE).trim() : null,
      maxRetryPerRun: num(env.MAX_RETRY_PER_RUN, 20),
      concurrency: num(env.CONCURRENCY, 3),
      retryAfterHours: num(env.RETRY_AFTER_HOURS, 6), // human-fixable exceptions (PO missing, total mismatch…): re-checked every 6 h, no AI call
      retryTransientAfterMinutes: num(env.RETRY_TRANSIENT_AFTER_MINUTES, 0), // AI/Books/attach errors: 0 = next run
      maxAttempts: num(env.MAX_ATTEMPTS, 28), // 28 × 6 h = a week of automatic reconciliation after the PO is fixed
      timeBudgetRatio: num(env.TIME_BUDGET_RATIO, 0.7),
      lockStaleMinutes: num(env.LOCK_STALE_MINUTES, 15),
    },

    // --- Report -------------------------------------------------------------
    report: {
      to: list(env.REPORT_TO, []),
      devCopy: list(env.REPORT_DEV_COPY, []),
      from: env.REPORT_FROM || env.SMTP_USER || '',
      subjectPrefix: env.REPORT_SUBJECT_PREFIX || 'AutoScan',
      perRun: bool(env.REPORT_PER_RUN, false), // per-run report by email too (default: log only; the daily digest is the email)
      dailyHour: env.DAILY_REPORT_HOUR === '' || String(env.DAILY_REPORT_HOUR).toLowerCase() === 'off' ? null : num(env.DAILY_REPORT_HOUR, 17), // local hour after which the daily digest goes out; off = never
      timeZone: env.REPORT_TIMEZONE || 'Europe/London',
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
  if (cfg.run.scanSince && Number.isNaN(Date.parse(cfg.run.scanSince))) {
    throw new Error(`SCAN_SINCE must be an ISO date such as 2026-11-17 (got "${cfg.run.scanSince}")`);
  }
  if (missing.length) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
  return cfg;
}

module.exports = { loadConfig, assertRuntimeConfig };
