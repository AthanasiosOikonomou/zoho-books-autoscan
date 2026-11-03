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
 *   listRetryCandidates({olderThan, maxAttempts, limit}) → record[]
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
});

const TERMINAL = new Set([STATUS.BILLED, STATUS.DUPLICATE]);
// WOULD_BILL is retry-eligible so the first LIVE run after a dry-run period bills them.
const RETRYABLE = new Set([STATUS.EXCEPTION, STATUS.BILLED_NO_ATTACH, STATUS.WOULD_BILL]);

const DOCUMENT_FIELDS = [
  'document_id', 'file_hash', 'file_name', 'mime', 'pages', 'status', 'reason_code', 'reason_text',
  'attempts', 'first_seen', 'last_attempt', 'vendor_id', 'vendor_name', 'po_id', 'po_number', 'bill_id', 'bill_number',
  'invoice_number', 'invoice_date', 'invoice_gross', 'extraction_json', 'prompt_version', 'model', 'tokens_in', 'tokens_out', 'run_id', 'claimed_run_id',
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
  async listRetryCandidates({ olderThan, maxAttempts, limit }) {
    const cutoff = new Date(olderThan).toISOString();
    return Object.values(this.data.documents)
      .filter((d) => RETRYABLE.has(d.status))
      .filter((d) => (d.attempts || 0) < maxAttempts)
      .filter((d) => !d.last_attempt || d.last_attempt <= cutoff)
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
 */
const DOC_READ_COLUMNS = [
  'ROWID', 'document_id', 'file_hash', 'file_name', 'mime', 'pages', 'status', 'reason_code', 'reason_text',
  'attempts', 'first_seen', 'last_attempt', 'vendor_id', 'po_id', 'bill_id', 'bill_number', 'invoice_number',
  'extraction_json', 'prompt_version', 'model',
]; // 20 — the ZCQL maximum
const DOC_DATETIME_FIELDS = ['first_seen', 'last_attempt'];
const RUN_DATETIME_FIELDS = ['started', 'finished'];
const RUN_READ_COLUMNS = ['ROWID', 'run_id', 'started', 'finished', 'status', 'notes'];
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
    return out;
  }

  _toRow(record, fields, dateFields) {
    const row = {};
    for (const f of fields) if (record[f] !== undefined && record[f] !== null) row[f] = record[f];
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
      for (const r of rows) { this.rowIds.set(r.document_id, r.ROWID); m.set(String(r.document_id), this._fromRow(r, DOC_DATETIME_FIELDS)); }
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
      if (existing[0]) rowId = existing[0].ROWID;
    }
    if (rowId) {
      await table.updateRow({ ROWID: rowId, ...row });
    } else {
      const inserted = await table.insertRow(row);
      rowId = inserted.ROWID;
    }
    this.rowIds.set(record.document_id, rowId);
    return { ...record, ROWID: rowId };
  }

  async listRetryCandidates({ olderThan, maxAttempts, limit }) {
    const cutoff = toZcqlDateTime(olderThan);
    const sql = `SELECT ${DOC_READ_COLUMNS.join(', ')} FROM document_state WHERE (status = 'EXCEPTION' OR status = 'BILLED_NO_ATTACH' OR status = 'WOULD_BILL') AND attempts < ${Number(maxAttempts)} AND last_attempt <= '${cutoff}' ORDER BY last_attempt ASC LIMIT ${Number(limit)}`;
    const rows = await this._query(sql, 'document_state');
    for (const r of rows) this.rowIds.set(r.document_id, r.ROWID);
    return rows.map((r) => this._fromRow(r, DOC_DATETIME_FIELDS));
  }

  async getActiveRun({ staleMinutes, now = Date.now() }) {
    const since = toZcqlDateTime(new Date(now - staleMinutes * 60000));
    const rows = await this._query(`SELECT ${RUN_READ_COLUMNS.join(', ')} FROM run_log WHERE status = 'RUNNING' AND started >= '${since}' LIMIT 1`, 'run_log');
    return rows[0] ? this._fromRow(rows[0], RUN_DATETIME_FIELDS) : null;
  }

  async beginRun(run) {
    const row = this._toRow({ ...run, status: 'RUNNING' }, RUN_FIELDS, RUN_DATETIME_FIELDS);
    const inserted = await this.ds.table('run_log').insertRow(row);
    return { ...run, status: 'RUNNING', ROWID: inserted.ROWID };
  }

  async endRun(run) {
    const row = this._toRow(run, RUN_FIELDS, RUN_DATETIME_FIELDS);
    await this.ds.table('run_log').updateRow({ ROWID: run.ROWID, ...row });
    return run;
  }
}

const RUN_FIELDS = ['run_id', 'started', 'finished', 'status', 'docs_seen', 'new_count', 'billed', 'exceptions', 'retried', 'errors', 'books_calls', 'claude_calls', 'tokens_in', 'tokens_out', 'est_cost_usd', 'report_sent', 'notes'];

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

module.exports = { STATUS, TERMINAL, RETRYABLE, DOCUMENT_FIELDS, RUN_FIELDS, DOC_READ_COLUMNS, JsonFileStore, CatalystStore, toZcqlDateTime, fromZcqlDateTime };
