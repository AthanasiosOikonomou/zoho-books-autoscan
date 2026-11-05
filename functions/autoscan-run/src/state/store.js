'use strict';

/**
 * Processing state — the memory that stops the cron from re-reading files.
 *
 * Two implementations behind one interface:
 *   - JsonFileStore   local runs / tests (a JSON file on disk, or pure memory)
 *   - CatalystStore   production (Catalyst Data Store tables document_state + run_log)
 *
 * Interface:
 *   getByDocumentIds(ids)            → Map<document_id, record>
 *   findByHash(file_hash)            → record | null
 *   upsert(record)                   → record     (keyed by document_id)
 *   listRetryCandidates({olderThan, transientOlderThan?, staleOlderThan?, maxAttempts, limit}) → record[]
 *   getActiveRun({staleMinutes})     → run | null
 *   beginRun(run)                    → run
 *   endRun(run)                      → run
 */

const STATUS = Object.freeze({
  NEW: 'NEW',
  PROCESSING: 'PROCESSING',
  BILLED: 'BILLED',
  BILLED_NO_ATTACH: 'BILLED_NO_ATTACH',
  EXCEPTION: 'EXCEPTION',
  DUPLICATE: 'DUPLICATE',
  WOULD_BILL: 'WOULD_BILL', // dry-run only
  CREDITED: 'CREDITED', // supplier credit note → vendor credit created
  WOULD_CREDIT: 'WOULD_CREDIT', // dry-run only
});

const TERMINAL = new Set([STATUS.BILLED, STATUS.DUPLICATE, STATUS.CREDITED]);
// WOULD_BILL / WOULD_CREDIT are retry-eligible so the first LIVE run after a dry-run period posts them.
const RETRYABLE = new Set([STATUS.EXCEPTION, STATUS.BILLED_NO_ATTACH, STATUS.WOULD_BILL, STATUS.WOULD_CREDIT]);
/** Still waiting for a human or a retry — what the daily report calls "needs attention". */
const OPEN_STATUSES = new Set([STATUS.EXCEPTION, STATUS.BILLED_NO_ATTACH, STATUS.WOULD_BILL, STATUS.WOULD_CREDIT]);
/** Reasons caused by us/the services, not by the document: retried on the next run instead of after RETRY_AFTER_HOURS. */
const TRANSIENT_REASONS = new Set(['AI_ERROR', 'BOOKS_ERROR', 'ATTACH_FAILED']);

/** Columns that are written as '' when the record holds null, so an update clears the previous value. */
const CLEAR_ON_NULL = ['reason_code', 'reason_text'];

const DOCUMENT_FIELDS = [
  'document_id', 'file_hash', 'file_name', 'mime', 'pages', 'status', 'reason_code', 'reason_text',
  'attempts', 'first_seen', 'last_attempt', 'vendor_id', 'vendor_name', 'po_id', 'po_number', 'bill_id', 'bill_number',
  'invoice_number', 'invoice_date', 'invoice_gross', 'extraction_json', 'prompt_version', 'model', 'tokens_in', 'tokens_out', 'run_id', 'claimed_run_id',
  'credit_id', 'credit_number',
];

// ------------------------------------------------------------------ local / test
class JsonFileStore {
  constructor({ filePath = null, fs = require('fs') } = {}) {
    this.filePath = filePath;
    this.fs = fs;
    this.data = { documents: {}, runs: {} };
    if (filePath && fs.existsSync(filePath)) {
      try { this.data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { /* start fresh */ }
    }
  }
  _save() {
    if (this.filePath) this.fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
  async getByDocumentIds(ids) {
    const m = new Map();
    for (const id of ids) if (this.data.documents[id]) m.set(id, this.data.documents[id]);
    return m;
  }
  async findByHash(hash) {
    if (!hash) return null;
    return Object.values(this.data.documents).find((d) => d.file_hash === hash && d.extraction_json) || null;
  }
  async upsert(record) {
    const prev = this.data.documents[record.document_id] || {};
    const merged = { ...prev, ...record };
    this.data.documents[record.document_id] = merged;
    this._save();
    return merged;
  }
  async listRetryCandidates({ olderThan, transientOlderThan, staleOlderThan, maxAttempts, limit }) {
    const cutoff = new Date(olderThan).toISOString();
    const tCutoff = new Date(transientOlderThan || olderThan).toISOString();
    const sCutoff = staleOlderThan ? new Date(staleOlderThan).toISOString() : null;
    const window = (d) => {
      if (d.status === STATUS.PROCESSING) return sCutoff; // a claim nobody finished (crashed run): retry once it is stale
      return TRANSIENT_REASONS.has(d.reason_code) ? tCutoff : cutoff;
    };
    return Object.values(this.data.documents)
      .filter((d) => RETRYABLE.has(d.status) || (sCutoff && d.status === STATUS.PROCESSING))
      .filter((d) => (d.attempts || 0) < maxAttempts)
      .filter((d) => !d.last_attempt || d.last_attempt <= window(d))
      .sort((a, b) => String(a.last_attempt).localeCompare(String(b.last_attempt)))
      .slice(0, limit);
  }
  async getActiveRun({ staleMinutes, now = Date.now() }) {
    const runs = Object.values(this.data.runs).filter((r) => r.status === 'RUNNING');
    const fresh = runs.find((r) => now - new Date(r.started).getTime() < staleMinutes * 60000);
    return fresh || null;
  }
  async beginRun(run) {
    this.data.runs[run.run_id] = { ...run, status: 'RUNNING' };
    this._save();
    return this.data.runs[run.run_id];
  }
  async endRun(run) {
    this.data.runs[run.run_id] = { ...(this.data.runs[run.run_id] || {}), ...run };
    this._save();
    return this.data.runs[run.run_id];
  }
  async recordRun(run) { this.data.runs[run.run_id] = { ...run }; this._save(); return this.data.runs[run.run_id]; }
  async getRunById(runId) { return this.data.runs[runId] || null; }
  // --- daily report
  async listDocumentsTouchedBetween({ since, until, limit = 300 }) {
    const a = new Date(since).toISOString(); const b = new Date(until).toISOString();
    return Object.values(this.data.documents).filter((d) => d.last_attempt && d.last_attempt >= a && d.last_attempt < b).sort((x, y) => String(x.last_attempt).localeCompare(String(y.last_attempt))).slice(0, limit);
  }
  async listOpenExceptions({ limit = 300 } = {}) {
    return Object.values(this.data.documents).filter((d) => OPEN_STATUSES.has(d.status)).sort((x, y) => String(x.first_seen).localeCompare(String(y.first_seen))).slice(0, limit);
  }
  async listRunsBetween({ since, until, limit = 300 }) {
    const a = new Date(since).toISOString(); const b = new Date(until).toISOString();
    return Object.values(this.data.runs).filter((r) => r.started && r.started >= a && r.started < b).slice(0, limit);
  }
}

// ------------------------------------------------------------------ Catalyst Data Store
/**
 * Tables — see docs/catalyst-setup.md for the exact column list to create in the console.
 *
 * Facts this adapter respects (Catalyst limits):
 *  - ZCQL SELECT allows at most 20 columns → explicit column lists, never SELECT *
 *  - `text` columns hold 10,000 chars → extraction_json is trimmed (line items dropped) if larger
 *  - DateTime columns take 'YYYY-MM-DD HH:mm:ss'; we store UTC and convert both ways
 *  - ZCQL results are wrapped as { table_name: {...} }
 *  - ROWIDs are 17-digit integers, above Number.MAX_SAFE_INTEGER. The insert/update REST responses carry ROWID as a
 *    JSON *number*, so JSON.parse rounds it (…17003 → …17004) and a later update by that ROWID hits the wrong row or
 *    none at all. ZCQL returns ROWID as a string, so after every insert the ROWID is re-read via ZCQL and never taken
 *    from the insert response.
 */
const DOC_READ_COLUMNS = [
  'ROWID', 'document_id', 'file_hash', 'file_name', 'status', 'reason_code', 'reason_text',
  'attempts', 'first_seen', 'last_attempt', 'vendor_id', 'po_id', 'bill_id', 'bill_number', 'invoice_number',
  'extraction_json', 'prompt_version', 'model', 'credit_id', 'credit_number',
]; // 20 — the ZCQL maximum (mime/pages are not needed on retry)
/** Columns the daily report reads (a second 20-column set). */
const DOC_REPORT_COLUMNS = [
  'ROWID', 'document_id', 'file_name', 'status', 'reason_code', 'reason_text', 'attempts', 'first_seen', 'last_attempt',
  'vendor_name', 'po_id', 'po_number', 'bill_id', 'bill_number', 'invoice_number', 'invoice_date', 'invoice_gross', 'credit_id', 'credit_number', 'run_id',
];
const DOC_DATETIME_FIELDS = ['first_seen', 'last_attempt'];
const RUN_DATETIME_FIELDS = ['started', 'finished'];
const RUN_READ_COLUMNS = ['ROWID', 'run_id', 'started', 'finished', 'status', 'notes'];
const RUN_REPORT_COLUMNS = ['ROWID', 'run_id', 'started', 'finished', 'status', 'docs_seen', 'new_count', 'billed', 'exceptions', 'retried', 'errors', 'books_calls', 'claude_calls', 'tokens_in', 'tokens_out', 'est_cost_usd', 'report_sent', 'notes'];
const TEXT_MAX = 9900;

class CatalystStore {
  constructor({ app, logger }) {
    this.app = app;
    this.logger = logger;
    this.ds = app.datastore();
    this.zcql = app.zcql();
    this.rowIds = new Map(); // document_id → ROWID
  }

  _esc(v) { return String(v).replace(/'/g, "''"); }

  async _query(sql, table) {
    const rows = await this.zcql.executeZCQLQuery(sql);
    return rows.map((r) => r[table] || Object.values(r)[0]).filter(Boolean);
  }

  _fromRow(r, dateFields) {
    const out = { ...r };
    for (const f of dateFields) if (out[f]) out[f] = fromZcqlDateTime(out[f]);
    if (out.attempts !== undefined && out.attempts !== null) out.attempts = Number(out.attempts);
    for (const f of CLEAR_ON_NULL) if (out[f] === '') out[f] = null;
    return out;
  }

  _toRow(record, fields, dateFields) {
    const row = {};
    for (const f of fields) if (record[f] !== undefined && record[f] !== null) row[f] = record[f];
    // A partial update never touches columns that are absent from the row, so a reason that was explicitly
    // cleared (null) must be sent as '' — otherwise a BILLED row keeps the reason of its last failed attempt.
    for (const f of CLEAR_ON_NULL) if (fields.includes(f) && record[f] === null) row[f] = '';
    for (const f of dateFields) if (row[f]) row[f] = toZcqlDateTime(row[f]);
    if (typeof row.extraction_json === 'string' && row.extraction_json.length > TEXT_MAX) {
      try {
        const e = JSON.parse(row.extraction_json);
        e.line_items = [];
        e.notes = `${e.notes || ''} [line items dropped: stored JSON exceeded ${TEXT_MAX} chars]`.trim();
        row.extraction_json = JSON.stringify(e).slice(0, TEXT_MAX);
      } catch { row.extraction_json = row.extraction_json.slice(0, TEXT_MAX); }
    }
    for (const k of Object.keys(row)) if (typeof row[k] === 'string' && row[k].length > TEXT_MAX) row[k] = row[k].slice(0, TEXT_MAX);
    return row;
  }

  async getByDocumentIds(ids) {
    const m = new Map();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50).map((id) => `'${this._esc(id)}'`).join(',');
      const rows = await this._query(`SELECT ${DOC_READ_COLUMNS.join(', ')} FROM document_state WHERE document_id IN (${chunk})`, 'document_state');
      for (const r of rows) { this.rowIds.set(String(r.document_id), String(r.ROWID)); m.set(String(r.document_id), this._fromRow(r, DOC_DATETIME_FIELDS)); }
    }
    return m;
  }

  async findByHash(hash) {
    if (!hash) return null;
    const rows = await this._query(`SELECT ${DOC_READ_COLUMNS.join(', ')} FROM document_state WHERE file_hash = '${this._esc(hash)}' AND extraction_json IS NOT NULL LIMIT 1`, 'document_state');
    return rows[0] ? this._fromRow(rows[0], DOC_DATETIME_FIELDS) : null;
  }

  async upsert(record) {
    const table = this.ds.table('document_state');
    const row = this._toRow(record, DOCUMENT_FIELDS, DOC_DATETIME_FIELDS);
    let rowId = this.rowIds.get(record.document_id);
    if (!rowId) {
      const existing = await this._query(`SELECT ROWID, document_id FROM document_state WHERE document_id = '${this._esc(record.document_id)}' LIMIT 1`, 'document_state');
      if (existing[0]) rowId = String(existing[0].ROWID);
    }
    if (rowId) {
      const updated = await this._write('update', () => table.updateRow({ ROWID: String(rowId), ...row }), { document_id: record.document_id, status: row.status, rowid: String(rowId), columns: Object.keys(row).length });
      this._assertWritten(updated, 'document_state', rowId, row);
    } else {
      const inserted = await this._write('insert', () => table.insertRow(row), { document_id: record.document_id, status: row.status, columns: Object.keys(row).length });
      if (!inserted || !inserted.ROWID) throw new Error(`document_state insert returned no ROWID: ${String(JSON.stringify(inserted)).slice(0, 300)}`);
      rowId = await this._exactRowId('document_state', `document_id = '${this._esc(record.document_id)}'`, inserted.ROWID);
    }
    this.rowIds.set(record.document_id, rowId);
    return { ...record, ROWID: rowId };
  }

  /**
   * Runs a Data Store write, logging the outcome. The SDK rejects with plain strings (HTTP errors) or with
   * CatalystError objects whose `code`/`message` are getters, so every failure is re-wrapped into a fresh Error.
   * Transient failures (network / 5xx / unparsable response) are retried a couple of times before giving up.
   */
  async _write(op, fn, meta, { attempts = 3, backoffMs = 400 } = {}) {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fn();
        this.logger.debug('store.write', { op, ...meta, attempt, resp_rowid: res && res.ROWID, resp_modified: res && res.MODIFIEDTIME });
        return res;
      } catch (err) {
        const e = wrapStoreError(err);
        const transient = isTransientStoreError(e) && attempt < attempts;
        this.logger[transient ? 'warn' : 'error'](transient ? 'store.write_retry' : 'store.write_failed', { op, ...meta, attempt, error: e });
        if (!transient) throw e;
        await new Promise((r) => setTimeout(r, backoffMs * attempt));
      }
    }
  }

  /** Exact (string) ROWID of a row just inserted — read back through ZCQL, because the insert response's ROWID is a rounded JS number. */
  async _exactRowId(table, where, roundedId) {
    const rows = await this._query(`SELECT ROWID FROM ${table} WHERE ${where} LIMIT 1`, table);
    const id = rows[0] && rows[0].ROWID !== undefined && rows[0].ROWID !== null ? String(rows[0].ROWID) : null;
    if (!id) throw Object.assign(new Error(`${table}: inserted row not found by ${where}`), { code: 'CATALYST_DS' });
    if (Number(id) !== Number(roundedId)) this.logger.warn('store.rowid_mismatch', { table, where, zcql: id, insert: String(roundedId) });
    return id;
  }

  /** The Data Store answers an update with the updated row; anything else means the row was NOT changed. (Its ROWID comes back rounded, so compare numerically.) */
  _assertWritten(res, table, rowId, row) {
    if (res && res.ROWID !== undefined && res.ROWID !== null && Number(res.ROWID) === Number(rowId)) return;
    const e = new Error(`${table} update of ROWID ${rowId} was not applied (response: ${String(JSON.stringify(res)).slice(0, 300)}; columns: ${Object.keys(row).join(',')})`);
    e.code = 'CATALYST_DS';
    throw e;
  }

  async listRetryCandidates({ olderThan, transientOlderThan, staleOlderThan, maxAttempts, limit }) {
    const cutoff = toZcqlDateTime(olderThan);
    const tCutoff = toZcqlDateTime(transientOlderThan || olderThan);
    const transient = [...TRANSIENT_REASONS].map((c) => `reason_code = '${c}'`).join(' OR ');
    // Rows older than the normal window match the first clause; transient-reason rows also match the second (shorter) one;
    // PROCESSING rows whose claim is older than the lock window belong to a run that died — third clause.
    const stale = staleOlderThan ? ` OR (status = 'PROCESSING' AND last_attempt <= '${toZcqlDateTime(staleOlderThan)}')` : '';
    const sql = `SELECT ${DOC_READ_COLUMNS.join(', ')} FROM document_state WHERE attempts < ${Number(maxAttempts)} AND (((status = 'EXCEPTION' OR status = 'BILLED_NO_ATTACH' OR status = 'WOULD_BILL' OR status = 'WOULD_CREDIT') AND last_attempt <= '${cutoff}') OR ((${transient}) AND last_attempt <= '${tCutoff}')${stale}) ORDER BY last_attempt ASC LIMIT ${Number(limit)}`;
    const rows = await this._query(sql, 'document_state');
    for (const r of rows) this.rowIds.set(String(r.document_id), String(r.ROWID));
    return rows.map((r) => this._fromRow(r, DOC_DATETIME_FIELDS));
  }

  async getActiveRun({ staleMinutes, now = Date.now() }) {
    const since = toZcqlDateTime(new Date(now - staleMinutes * 60000));
    const rows = await this._query(`SELECT ${RUN_READ_COLUMNS.join(', ')} FROM run_log WHERE status = 'RUNNING' AND started >= '${since}' LIMIT 1`, 'run_log');
    return rows[0] ? this._fromRow(rows[0], RUN_DATETIME_FIELDS) : null;
  }

  async beginRun(run) {
    const row = this._toRow({ ...run, status: 'RUNNING' }, RUN_FIELDS, RUN_DATETIME_FIELDS);
    const inserted = await this._write('insert', () => this.ds.table('run_log').insertRow(row), { run_id: run.run_id, columns: Object.keys(row).length });
    if (!inserted || !inserted.ROWID) throw new Error(`run_log insert returned no ROWID: ${String(JSON.stringify(inserted)).slice(0, 300)}`);
    const rowId = await this._exactRowId('run_log', `run_id = '${this._esc(run.run_id)}'`, inserted.ROWID);
    return { ...run, status: 'RUNNING', ROWID: rowId };
  }

  async endRun(run) {
    const row = this._toRow(run, RUN_FIELDS, RUN_DATETIME_FIELDS);
    const updated = await this._write('update', () => this.ds.table('run_log').updateRow({ ROWID: String(run.ROWID), ...row }), { run_id: run.run_id, status: row.status, rowid: String(run.ROWID), columns: Object.keys(row).length });
    this._assertWritten(updated, 'run_log', run.ROWID, row);
    return run;
  }

  /** One-shot row (e.g. the daily-report marker): inserted with its final status, never RUNNING. */
  async recordRun(run) {
    const row = this._toRow(run, RUN_FIELDS, RUN_DATETIME_FIELDS);
    const inserted = await this._write('insert', () => this.ds.table('run_log').insertRow(row), { run_id: run.run_id, status: row.status, columns: Object.keys(row).length });
    if (!inserted || !inserted.ROWID) throw new Error(`run_log insert returned no ROWID: ${String(JSON.stringify(inserted)).slice(0, 300)}`);
    return run;
  }
  async getRunById(runId) {
    const rows = await this._query(`SELECT ${RUN_READ_COLUMNS.join(', ')} FROM run_log WHERE run_id = '${this._esc(runId)}' LIMIT 1`, 'run_log');
    return rows[0] ? this._fromRow(rows[0], RUN_DATETIME_FIELDS) : null;
  }

  // --- daily report (ZCQL: ≤ 20 columns, ≤ 300 rows per query)
  async listDocumentsTouchedBetween({ since, until, limit = 300 }) {
    const rows = await this._query(`SELECT ${DOC_REPORT_COLUMNS.join(', ')} FROM document_state WHERE last_attempt >= '${toZcqlDateTime(since)}' AND last_attempt < '${toZcqlDateTime(until)}' ORDER BY last_attempt ASC LIMIT ${Number(limit)}`, 'document_state');
    return rows.map((r) => this._fromRow(r, DOC_DATETIME_FIELDS));
  }
  async listOpenExceptions({ limit = 300 } = {}) {
    const where = [...OPEN_STATUSES].map((s) => `status = '${s}'`).join(' OR ');
    const rows = await this._query(`SELECT ${DOC_REPORT_COLUMNS.join(', ')} FROM document_state WHERE ${where} ORDER BY first_seen ASC LIMIT ${Number(limit)}`, 'document_state');
    return rows.map((r) => this._fromRow(r, DOC_DATETIME_FIELDS));
  }
  async listRunsBetween({ since, until, limit = 300 }) {
    const rows = await this._query(`SELECT ${RUN_REPORT_COLUMNS.join(', ')} FROM run_log WHERE started >= '${toZcqlDateTime(since)}' AND started < '${toZcqlDateTime(until)}' ORDER BY started ASC LIMIT ${Number(limit)}`, 'run_log');
    return rows.map((r) => this._fromRow(r, RUN_DATETIME_FIELDS));
  }
}

const RUN_FIELDS = ['run_id', 'started', 'finished', 'status', 'docs_seen', 'new_count', 'billed', 'exceptions', 'retried', 'errors', 'books_calls', 'claude_calls', 'tokens_in', 'tokens_out', 'est_cost_usd', 'report_sent', 'notes'];

/** A fresh Error carrying the SDK error's code/message (never mutates the SDK object: its `code` is a getter-only property). */
function wrapStoreError(err) {
  if (typeof err === 'string') { const e = new Error(err); e.code = /status (\d{3})/.test(err) ? `HTTP_${RegExp.$1}` : 'CATALYST_DS'; e.status = Number((err.match(/status (\d{3})/) || [])[1]) || undefined; return e; }
  let code; let message; let status;
  try { code = err && err.code; } catch (_) { /* getter may throw */ }
  try { message = err && err.message; } catch (_) { /* ignore */ }
  try { status = err && (err.status || err.statusCode || (err.errorInfo && err.errorInfo.status)); } catch (_) { /* ignore */ }
  if (!message) { try { message = JSON.stringify(err && typeof err.toJSON === 'function' ? err.toJSON() : err).slice(0, 500); } catch (_) { message = String(err); } }
  const e = new Error(message || 'Data Store error');
  e.code = code ? String(code) : 'CATALYST_DS';
  if (status) e.status = status;
  e.cause = err;
  return e;
}
function isTransientStoreError(e) {
  const c = String(e.code || ''); const s = Number(e.status || 0); const m = String(e.message || '').toLowerCase();
  if (s >= 500 || s === 429) return true;
  if (/^(request_failure|empty_response|unparsable_response|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|HTTP_5\d\d|HTTP_429)$/i.test(c)) return true;
  return /socket hang up|timeout|temporarily|try again|internal server error|service unavailable|bad gateway/.test(m);
}

function toZcqlDateTime(d) {
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())}:${p(x.getUTCSeconds())}`;
}
function fromZcqlDateTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s));
  if (!m) return String(s);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
}

module.exports = { STATUS, TERMINAL, RETRYABLE, OPEN_STATUSES, TRANSIENT_REASONS, wrapStoreError, isTransientStoreError, DOCUMENT_FIELDS, RUN_FIELDS, DOC_READ_COLUMNS, DOC_REPORT_COLUMNS, JsonFileStore, CatalystStore, toZcqlDateTime, fromZcqlDateTime };
