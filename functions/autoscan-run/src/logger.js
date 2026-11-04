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
    // Always stdout: Catalyst's log viewer shows console.log lines for Job functions; warn/error (stderr) were not visible.
    sink.log(JSON.stringify(rec));
  }

  return {
    debug: (m, d) => line('debug', m, d),
    info: (m, d) => line('info', m, d),
    warn: (m, d) => line('warn', m, d),
    error: (m, d) => line('error', m, d),
    child: (extra) => createLogger({ runId: extra.runId || runId, level, sink }),
  };
}

const SECRET_KEYS = /(access_token|refresh_token|api_?key|client_secret|secret|authorization|password|_pass)$/i;
function scrub(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.test(k)) out[k] = '[redacted]';
    else if (k === 'error' || v instanceof Error) out[k] = describeError(v);
    else out[k] = v;
  }
  return out;
}

/** Loggable shape of anything that was thrown — Error, SDK error object, string, plain object. */
function describeError(err) {
  if (err === undefined || err === null) return { message: String(err) };
  if (typeof err === 'string') return { message: err };
  const d = {
    name: err.name,
    message: err.message,
    code: err.code,
    status: err.status || err.statusCode || err.status_code,
    type: err.type || (err.error && err.error.type),
  };
  if (err.cause) d.cause = typeof err.cause === 'object' ? { name: err.cause.name, message: err.cause.message, code: err.cause.code } : String(err.cause);
  if (!d.message) {
    // Non-Error rejection (e.g. a Catalyst SDK object): keep a bounded JSON of it, secrets scrubbed by key name
    try { d.detail = JSON.stringify(err, (k, v) => (SECRET_KEYS.test(k) ? '[redacted]' : v)).slice(0, 600); } catch (_) { d.detail = String(err); }
  }
  for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
  return d;
}

/** One-line human message for a thrown value (reason_text in the report). */
function errorMessage(err) {
  const d = describeError(err);
  return d.message || d.detail || (d.name ? `${d.name}${d.code ? ` ${d.code}` : ''}` : 'unknown error');
}

module.exports = { createLogger, describeError, errorMessage };
