'use strict';

/**
 * Minimal structured logger. Every line carries the run id so Catalyst logs
 * can be filtered per run. Never log tokens, secrets or extracted invoice
 * content — only ids, reason codes and counts.
 */
function createLogger({ runId = '-', level = 'info', sink = console } = {}) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  const min = levels[level] || 20;

  function line(lvl, msg, data) {
    if (levels[lvl] < min) return;
    const rec = { t: new Date().toISOString(), lvl, run: runId, msg };
    if (data && typeof data === 'object') Object.assign(rec, scrub(data));
    const out = JSON.stringify(rec);
    if (lvl === 'error') sink.error(out);
    else if (lvl === 'warn') sink.warn(out);
    else sink.log(out);
  }

  return {
    debug: (m, d) => line('debug', m, d),
    info: (m, d) => line('info', m, d),
    warn: (m, d) => line('warn', m, d),
    error: (m, d) => line('error', m, d),
    child: (extra) => createLogger({ runId: extra.runId || runId, level, sink }),
  };
}

const SECRET_KEYS = /(access_token|refresh_token|api_?key|client_secret|secret|authorization|password)$/i;
function scrub(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.test(k)) out[k] = '[redacted]';
    else if (v instanceof Error) out[k] = { name: v.name, message: v.message, code: v.code };
    else out[k] = v;
  }
  return out;
}

module.exports = { createLogger };
