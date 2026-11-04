'use strict';

const { STATUS } = require('../state/store');
const { REASONS } = require('../pipeline/reasons');

/**
 * Builds the run report: subject + HTML + plain text.
 * Designed for finance: what was billed, what needs a human and why, with links.
 */
function buildReport({ run, results, config, stoppedEarly }) {
  const billed = results.filter((r) => r.status === STATUS.BILLED);
  const wouldBill = results.filter((r) => r.status === STATUS.WOULD_BILL);
  const dupes = results.filter((r) => r.status === STATUS.DUPLICATE);
  const exceptions = results.filter((r) => ![STATUS.BILLED, STATUS.WOULD_BILL, STATUS.DUPLICATE].includes(r.status));

  const groups = new Map();
  for (const r of exceptions) {
    const k = r.reason_code || 'OTHER';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const dry = config.run.dryRun ? ' [DRY-RUN]' : '';
  const subject = `${config.report.subjectPrefix}${dry}: ${billed.length + wouldBill.length} billed, ${exceptions.length} to review, ${dupes.length} duplicates — ${fmtDate(run.started)}`;

  const h = [];
  h.push(`<div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:900px">`);
  h.push(`<h2 style="margin:0 0 8px">AutoScan run report${dry}</h2>`);
  h.push(`<div style="color:#666;font-size:13px;margin-bottom:16px">Run ${esc(run.run_id)} · started ${esc(fmtDate(run.started))} · ${esc(String(results.length))} documents processed${stoppedEarly ? ` · <b>stopped early: ${esc(stoppedEarly)}</b> (the rest continues next run)` : ''}</div>`);

  h.push(summaryTable([
    ['New documents', run.new_count], ['Re-checked exceptions', run.retried],
    [config.run.dryRun ? 'Would be billed' : 'Bills created', billed.length + wouldBill.length], ['Need review', exceptions.length],
    ['Duplicates (no action)', dupes.length], ['Errors (auto-retry)', run.errors],
  ]));

  if (config.run.dryRun) {
    h.push(`<p style="background:#fff8e1;border-left:4px solid #f0ad4e;padding:8px 12px">Dry-run: nothing was written to Zoho Books. This report shows what the automation <i>would</i> have done.</p>`);
  }

  if (exceptions.length) {
    h.push(`<h3 style="margin:20px 0 8px;color:#b23">Needs review (${exceptions.length})</h3>`);
    for (const [code, rows] of groups) {
      const def = REASONS[code] || { action: '' };
      h.push(`<div style="margin:10px 0 4px"><b>${esc(code)}</b> · ${rows.length} · <span style="color:#555">${esc(def.action)}</span></div>`);
      h.push(`<table style="border-collapse:collapse;width:100%;font-size:13px">`);
      h.push(`<tr style="background:#f4f4f4"><th align="left" style="padding:4px">Document</th><th align="left" style="padding:4px">Supplier</th><th align="left" style="padding:4px">Invoice #</th><th align="left" style="padding:4px">PO ref read</th><th align="right" style="padding:4px">Invoice total</th><th align="left" style="padding:4px">Detail</th><th align="left" style="padding:4px">Links</th></tr>`);
      for (const r of rows) h.push(row(r, config));
      h.push(`</table>`);
    }
  }

  const done = config.run.dryRun ? wouldBill : billed;
  if (done.length) {
    h.push(`<h3 style="margin:20px 0 8px;color:#2a7">${config.run.dryRun ? 'Would be billed' : 'Bills created'} (${done.length})</h3>`);
    h.push(`<table style="border-collapse:collapse;width:100%;font-size:13px">`);
    h.push(`<tr style="background:#f4f4f4"><th align="left" style="padding:4px">Document</th><th align="left" style="padding:4px">Supplier</th><th align="left" style="padding:4px">Invoice #</th><th align="left" style="padding:4px">PO</th><th align="right" style="padding:4px">Total</th><th align="left" style="padding:4px">Links</th></tr>`);
    for (const r of done) {
      h.push(`<tr><td style="padding:4px;border-top:1px solid #eee">${esc(r.file_name)}</td><td style="padding:4px;border-top:1px solid #eee">${esc(r.po && r.po.vendor)}</td><td style="padding:4px;border-top:1px solid #eee">${esc(r.extracted && r.extracted.invoice_number)}</td><td style="padding:4px;border-top:1px solid #eee">${esc(r.po && r.po.number)}</td><td align="right" style="padding:4px;border-top:1px solid #eee">${money(r.extracted && r.extracted.gross)}${r.note ? `<div style="color:#b23;font-size:12px">${esc(r.note)}</div>` : ''}</td><td style="padding:4px;border-top:1px solid #eee">${links(r)}</td></tr>`);
    }
    h.push(`</table>`);
  }

  if (dupes.length) {
    h.push(`<h3 style="margin:20px 0 8px;color:#888">Duplicates — already billed (${dupes.length})</h3>`);
    h.push(`<table style="border-collapse:collapse;width:100%;font-size:13px">`);
    for (const r of dupes) h.push(`<tr><td style="padding:4px;border-top:1px solid #eee">${esc(r.file_name)}</td><td style="padding:4px;border-top:1px solid #eee">${esc(r.extracted && r.extracted.invoice_number)}</td><td style="padding:4px;border-top:1px solid #eee">${esc(r.reason_text)}</td><td style="padding:4px;border-top:1px solid #eee">${links(r)}</td></tr>`);
    h.push(`</table>`);
  }

  h.push(`<div style="color:#999;font-size:12px;margin-top:24px">Books API calls: ${esc(String(run.books_calls || 0))} · AI calls: ${esc(String(run.claude_calls || 0))} · est. AI cost: $${esc(Number(run.est_cost_usd || 0).toFixed(3))}</div>`);
  h.push(`</div>`);

  const text = [
    subject, '',
    `New: ${run.new_count}  Retried: ${run.retried}  Billed: ${billed.length + wouldBill.length}  Review: ${exceptions.length}  Duplicates: ${dupes.length}`,
    ...[...groups].flatMap(([code, rows]) => [``, `${code} (${rows.length}): ${(REASONS[code] || {}).action || ''}`, ...rows.map((r) => `  - ${r.file_name} | ${r.extracted ? r.extracted.invoice_number : ''} | ${r.reason_text || ''}`)]),
  ].join('\n');

  return { subject, html: h.join('\n'), text, to: config.report.to, cc: config.report.devCopy, from: config.report.from };
}

function row(r, config) {
  const e = r.extracted || {};
  return `<tr><td style="padding:4px;border-top:1px solid #eee">${esc(r.file_name)}</td><td style="padding:4px;border-top:1px solid #eee">${esc(e.supplier_name)}</td><td style="padding:4px;border-top:1px solid #eee">${esc(e.invoice_number)}</td><td style="padding:4px;border-top:1px solid #eee">${esc(e.po_reference)}</td><td align="right" style="padding:4px;border-top:1px solid #eee">${money(e.gross)}</td><td style="padding:4px;border-top:1px solid #eee">${esc(r.reason_text)}${e.confidence !== undefined ? ` <span style="color:#999">(conf ${Math.round((e.confidence || 0) * 100)}%)</span>` : ''}</td><td style="padding:4px;border-top:1px solid #eee">${links(r, config)}</td></tr>`;
}

function links(r) {
  const out = [];
  if (r.links && r.links.po) out.push(`<a href="${esc(r.links.po)}">PO</a>`);
  if (r.links && r.links.bill) out.push(`<a href="${esc(r.links.bill)}">Bill</a>`);
  return out.join(' · ') || '';
}

function summaryTable(pairs) {
  const cells = pairs.map(([k, v]) => `<td style="padding:6px 12px 6px 0"><b>${esc(k)}:</b> ${esc(String(v ?? 0))}</td>`);
  const rows = [];
  for (let i = 0; i < cells.length; i += 3) rows.push(`<tr>${cells.slice(i, i + 3).join('')}</tr>`);
  return `<table style="font-size:14px;border-collapse:collapse">${rows.join('')}</table>`;
}

function esc(v) { return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function money(n) { return Number.isFinite(Number(n)) && n !== null ? Number(n).toFixed(2) : ''; }
function fmtDate(iso) { try { return new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London' }); } catch { return String(iso); } }

module.exports = { buildReport };
