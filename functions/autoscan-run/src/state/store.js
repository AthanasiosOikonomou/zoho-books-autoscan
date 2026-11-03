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
 * Tables (create in Catalyst console, Development env first):
 *
 * document_state: document_id (Text, unique), file_hash (Text), file_name (Text), mime (Text), pages (Int),
 *   status (Text), reason_code (Text), reason_text (Text), attempts (Int), first_seen (DateTime),
 *   last_attempt (DateTime), vendor_id (Text), vendor_name (Text), po_id (Text), po_number (Text),
 *   bill_id (Text), bill_number (Text), invoice_number (Text), invoice_date (Text), invoice_gross (Double),
 *   extraction_json (Text, max length), prompt_version (Text), model (Text), tokens_in (Int), tokens_out (Int), run_id (Text), claimed_run_id (Text)
 *
 * run_log: run_id (Text, unique), started (DateTime), finished (DateTime), status (Text), docs_seen (Int),
 *   new_count (Int), billed (Int), exceptions (Int), retried (Int), errors (Int), books_calls (Int),
 *   claude_calls (Int), tokens_in (Int), tokens_out (Int), est_cost_usd (Double), report_sent (Boolean), notes (Text)
 */
class CatalystStore {
  constructor({ app, logger }) {
    this.app = app;
    this.logger = logger;
    this.ds = app.datastore();
    this.zcql = app.zcql();
    this.rowIds = new Map(); // document_id → ROWID
  }

  _esc(v) { return String(v).replace(/'/g, "''"); }

  async _query(sql) {
    const rows = await this.zcql.executeZCQLQuery(sql);
    // ZCQL wraps each row as { TableName: {...} }
    return rows.map((r) => r.document_state || r.run_log || Object.values(r)[0]);
  }

  async getByDocumentIds(ids) {
    const m = new Map();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50).map((id) => `'${this._esc(id)}'`).join(',');
      const rows = await this._query(`SELECT * FROM document_state WHERE document_id IN (${chunk})`);
      for (const r of rows) { this.rowIds.set(r.document_id, r.ROWID); m.set(r.document_id, r); }
    }
    return m;
  }

  async findByHash(hash) {
    if (!hash) return null;
    const rows = await this._query(`SELECT * FROM document_state WHERE file_hash = '${this._esc(hash)}' AND extraction_json IS NOT NULL LIMIT 1`);
    return rows[0] || null;
  }

  async upsert(record) {
    const table = this.ds.table('document_state');
    const row = {};
    for (const f of DOCUMENT_FIELDS) if (record[f] !== undefined) row[f] = record[f];
    let rowId = this.rowIds.get(record.document_id);
    if (!rowId) {
      const existing = await this._query(`SELECT ROWID, document_id FROM document_state WHERE document_id = '${this._esc(record.document_id)}' LIMIT 1`);
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
    const sql = `SELECT * FROM document_state WHERE (status = 'EXCEPTION' OR status = 'BILLED_NO_ATTACH' OR status = 'WOULD_BILL') AND attempts < ${Number(maxAttempts)} AND last_attempt <= '${cutoff}' ORDER BY last_attempt ASC LIMIT ${Number(limit)}`;
    const rows = await this._query(sql);
    for (const r of rows) this.rowIds.set(r.document_id, r.ROWID);
    return rows;
  }

  async getActiveRun({ staleMinutes, now = Date.now() }) {
    const since = toZcqlDateTime(new Date(now - staleMinutes * 60000));
    const rows = await this._query(`SELECT * FROM run_log WHERE status = 'RUNNING' AND started >= '${since}' LIMIT 1`);
    return rows[0] || null;
  }

  async beginRun(run) {
    const inserted = await this.ds.table('run_log').insertRow({ ...run, status: 'RUNNING' });
    return { ...run, status: 'RUNNING', ROWID: inserted.ROWID };
  }

  async endRun(run) {
    await this.ds.table('run_log').updateRow({ ROWID: run.ROWID, ...stripRowId(run) });
    return run;
  }
}

function stripRowId(o) { const { ROWID, ...rest } = o; return rest; }
function toZcqlDateTime(d) {
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())}:${p(x.getUTCSeconds())}`;
}

module.exports = { STATUS, TERMINAL, RETRYABLE, DOCUMENT_FIELDS, JsonFileStore, CatalystStore, toZcqlDateTime };
