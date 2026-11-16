'use strict';

/**
 * End-of-day digest for finance: one email per day.
 *   - KPI tiles (bills, credits, needs attention, duplicates, AI cost)
 *   - bills created today (links into Books)
 *   - vendor credits today (and whether they are linked to a bill)
 *   - everything still waiting for a human, grouped by reason with the action to take
 * Pure function: rows in → { subject, html, text } out. Email-safe HTML (tables + inline styles).
 */

const { STATUS } = require('../state/store');
const { REASONS } = require('../pipeline/reasons');

const ORDER = ['TOTAL_MISMATCH', 'BILL_TEMPLATE_MISMATCH', 'PO_NOT_FOUND', 'NO_PO_REF', 'LOW_CONFIDENCE', 'CREDIT_TOTAL_MISMATCH', 'CREDIT_NOTE', 'NOT_AN_INVOICE', 'UNSUPPORTED_FILE', 'PAGE_LIMIT', 'ATTACH_FAILED', 'BOOKS_ERROR', 'AI_ERROR'];

/** Day boundaries in a time zone. Returns { ymd, label, since, until } (since/until are UTC Dates). */
function dayRange(now, timeZone = 'Europe/London') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(now).map((p) => [p.type, p.value]));
  const y = Number(parts.year); const mo = Number(parts.month); const d = Number(parts.day);
  const h = Number(parts.hour) % 24; const mi = Number(parts.minute); const s = Number(parts.second);
  const localAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetMs = localAsUtc - Math.floor(now.getTime() / 1000) * 1000; // tz offset at this instant
  const since = new Date(Date.UTC(y, mo - 1, d) - offsetMs);
  const until = new Date(since.getTime() + 24 * 3600000);
  const ymd = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const label = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(now);
  return { ymd, label, since, until, hour: h };
}

function buildDailyReport({ day, docs, open, runs, config }) {
  const dry = config.run.dryRun;
  const billed = docs.filter((r) => r.status === STATUS.BILLED);
  const wouldBill = docs.filter((r) => r.status === STATUS.WOULD_BILL);
  const credited = docs.filter((r) => r.status === STATUS.CREDITED);
  const wouldCredit = docs.filter((r) => r.status === STATUS.WOULD_CREDIT);
  const dupes = docs.filter((r) => r.status === STATUS.DUPLICATE);
  const newToday = docs.filter((r) => r.first_seen && r.first_seen >= day.since.toISOString() && r.first_seen < day.until.toISOString());
  const attention = open.filter((r) => r.status === STATUS.EXCEPTION || r.status === STATUS.BILLED_NO_ATTACH);
  const pending = open.filter((r) => r.status === STATUS.WOULD_BILL || r.status === STATUS.WOULD_CREDIT);

  const groups = new Map();
  for (const r of attention) { const k = r.reason_code || 'OTHER'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const orderedGroups = [...groups.entries()].sort((a, b) => (idx(a[0]) - idx(b[0])) || b[1].length - a[1].length);

  const sum = (rows) => rows.reduce((s, r) => s + (Number(r.invoice_gross) || 0), 0);
  const cost = runs.reduce((s, r) => s + (Number(r.est_cost_usd) || 0), 0);
  const aiCalls = runs.reduce((s, r) => s + (Number(r.claude_calls) || 0), 0);
  const booksCalls = runs.reduce((s, r) => s + (Number(r.books_calls) || 0), 0);
  const base = config.report.booksAppBase;
  const billLink = (r) => (r.bill_id ? `${base}#/bills/${r.bill_id}` : null);
  const poLink = (r) => (r.po_id ? `${base}#/purchaseorders/${r.po_id}` : null);
  const creditLink = (r) => (r.credit_id ? `${base}#/vendorcredits/${r.credit_id}` : null);

  const billsDone = dry ? wouldBill : billed;
  const creditsDone = dry ? wouldCredit : credited;
  const subject = `${config.report.subjectPrefix} daily${dry ? ' [DRY-RUN]' : ''} — ${day.label}: ${billsDone.length} ${dry ? 'would be billed' : 'bills'}${creditsDone.length ? `, ${creditsDone.length} credit${creditsDone.length === 1 ? '' : 's'}` : ''}, ${attention.length} need attention`;

  // ---------------------------------------------------------------- HTML
  const h = [];
  h.push(`<div style="background:#f3f5f8;padding:24px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2933">`);
  h.push(`<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:760px;margin:0 auto"><tr><td>`);
  // header
  h.push(`<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#1b2a41;border-radius:10px 10px 0 0"><tr><td style="padding:20px 24px">`);
  h.push(`<div style="color:#9fb3c8;font-size:12px;letter-spacing:.08em;text-transform:uppercase">${esc(config.report.subjectPrefix)} · daily summary</div>`);
  h.push(`<div style="color:#fff;font-size:22px;font-weight:600;margin-top:4px">${esc(day.label)}${dry ? ' <span style="font-size:12px;background:#f0ad4e;color:#1b2a41;border-radius:4px;padding:2px 6px;vertical-align:middle">DRY-RUN</span>' : ''}</div>`);
  h.push(`</td></tr></table>`);
  // body
  h.push(`<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fff;border-radius:0 0 10px 10px;border:1px solid #e3e8ef;border-top:0"><tr><td style="padding:20px 24px">`);
  // KPI tiles
  h.push(`<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>`);
  h.push(tile(dry ? 'Would be billed' : 'Bills created', String(billsDone.length), `£${money(sum(billsDone))}`, '#1e8e5a'));
  h.push(tile(dry ? 'Would be credited' : 'Vendor credits', String(creditsDone.length), `£${money(sum(creditsDone))}`, '#2f6fb3'));
  h.push(tile('Need attention', String(attention.length), attention.length ? 'see below' : 'nothing open', attention.length ? '#c0392b' : '#1e8e5a'));
  h.push(tile('New documents', String(newToday.length), `${dupes.length} duplicate${dupes.length === 1 ? '' : 's'}`, '#5c6b7a'));
  h.push(`</tr></table>`);
  if (dry) h.push(`<p style="background:#fff8e1;border-left:4px solid #f0ad4e;padding:8px 12px;font-size:13px;margin:16px 0 0">Dry-run: nothing was written to Zoho Books today. The figures show what the automation would have done.</p>`);

  // bills
  if (billsDone.length) {
    h.push(section(dry ? 'Would be billed today' : 'Bills created today', billsDone.length, '#1e8e5a'));
    h.push(tableOpen(['Supplier', 'Invoice #', 'Invoice date', 'PO', 'Total', '']));
    for (const r of billsDone) {
      h.push(`<tr>${td(esc(r.vendor_name))}${td(esc(r.invoice_number))}${td(esc(r.invoice_date))}${td(r.po_number ? link(poLink(r), r.po_number) : '')}${td(`£${money(r.invoice_gross)}`, 'right')}${td(billLink(r) ? link(billLink(r), 'Open bill') : '')}</tr>`);
      // what the automation decided on the way (lower price accepted, matched by value → code to add, carriage left open…)
      if (r.reason_text) h.push(`<tr><td colspan="6" style="padding:0 8px 8px;font-size:12px;color:#8a6d1b">Note: ${esc(r.reason_text)}</td></tr>`);
    }
    h.push(`</table>`);
  }
  // credits
  if (creditsDone.length) {
    h.push(section(dry ? 'Would be credited today' : 'Vendor credits today', creditsDone.length, '#2f6fb3'));
    h.push(tableOpen(['Supplier', 'Credit note #', 'Date', 'PO', 'Against bill', 'Total', '']));
    for (const r of creditsDone) h.push(`<tr>${td(esc(r.vendor_name))}${td(esc(r.credit_number || r.invoice_number))}${td(esc(r.invoice_date))}${td(r.po_number ? link(poLink(r), r.po_number) : '')}${td(r.bill_number ? link(billLink(r), r.bill_number) : '<span style="color:#c0392b">not linked to any bill</span>')}${td(`£${money(r.invoice_gross)}`, 'right')}${td(creditLink(r) ? link(creditLink(r), 'Open credit') : '')}</tr>`);
    h.push(`</table>`);
  }
  // attention
  if (attention.length) {
    h.push(section('Needs attention', attention.length, '#c0392b'));
    h.push(`<p style="font-size:13px;color:#52606d;margin:0 0 8px">Everything still waiting for a human, oldest first. Fix the PO (or the document) in Zoho Books — the next run re-checks it automatically; nothing to click here.</p>`);
    for (const [code, rows] of orderedGroups) {
      const def = REASONS[code] || { action: '' };
      h.push(`<div style="margin:14px 0 6px;font-size:14px"><b>${esc(title(code))}</b> <span style="color:#52606d">· ${rows.length}</span><div style="font-size:13px;color:#52606d;margin-top:2px">${esc(def.action)}</div></div>`);
      h.push(tableOpen(['Document', 'Supplier', 'Invoice #', 'PO', 'Total', 'Detail', 'Waiting', '']));
      for (const r of rows.sort((a, b) => String(a.first_seen).localeCompare(String(b.first_seen)))) {
        h.push(`<tr>${td(esc(r.file_name))}${td(esc(r.vendor_name))}${td(esc(r.invoice_number))}${td(r.po_number ? link(poLink(r), r.po_number) : '')}${td(r.invoice_gross !== null && r.invoice_gross !== undefined && r.invoice_gross !== '' ? `£${money(r.invoice_gross)}` : '', 'right')}${td(esc(r.reason_text))}${td(esc(age(r.first_seen, day.until)))}${td(billLink(r) ? link(billLink(r), 'Bill') : '')}</tr>`);
      }
      h.push(`</table>`);
    }
  } else {
    h.push(`<p style="margin:20px 0 0;padding:12px;background:#edf7f1;border-radius:6px;color:#1e8e5a;font-size:14px">Nothing is waiting for review.</p>`);
  }
  if (pending.length && !dry) {
    h.push(`<p style="font-size:12px;color:#52606d;margin-top:16px">${pending.length} document${pending.length === 1 ? '' : 's'} from the dry-run period will be posted on the next run.</p>`);
  }
  if (dupes.length) {
    h.push(section('Duplicates today — nothing to do', dupes.length, '#5c6b7a'));
    h.push(tableOpen(['Document', 'Supplier', 'Invoice #', 'Existing bill', '']));
    for (const r of dupes) h.push(`<tr>${td(esc(r.file_name))}${td(esc(r.vendor_name))}${td(esc(r.invoice_number))}${td(esc(r.bill_number || r.credit_number))}${td(billLink(r) ? link(billLink(r), 'Open bill') : creditLink(r) ? link(creditLink(r), 'Open credit') : '')}</tr>`);
    h.push(`</table>`);
  }
  // footer
  h.push(`<div style="margin-top:22px;padding-top:12px;border-top:1px solid #e3e8ef;color:#7b8794;font-size:12px">${runs.length} run${runs.length === 1 ? '' : 's'} today · ${booksCalls} Zoho Books API calls · ${aiCalls} AI reads · est. AI cost $${cost.toFixed(3)} · generated ${esc(new Intl.DateTimeFormat('en-GB', { timeZone: config.report.timeZone, hour: '2-digit', minute: '2-digit' }).format(day.until > new Date() ? new Date() : day.until))}</div>`);
  h.push(`</td></tr></table>`);
  h.push(`</td></tr></table></div>`);

  // ---------------------------------------------------------------- text
  const text = [
    subject, '',
    `${dry ? 'Would be billed' : 'Bills created'}: ${billsDone.length} (£${money(sum(billsDone))})   ${dry ? 'Would be credited' : 'Vendor credits'}: ${creditsDone.length}   Need attention: ${attention.length}   New: ${newToday.length}   Duplicates: ${dupes.length}`,
    ...(billsDone.length ? ['', dry ? 'WOULD BE BILLED' : 'BILLS CREATED', ...billsDone.map((r) => `  - ${r.vendor_name || ''} | ${r.invoice_number || ''} | ${r.po_number || ''} | £${money(r.invoice_gross)}${billLink(r) ? ` | ${billLink(r)}` : ''}${r.reason_text ? ` | note: ${r.reason_text}` : ''}`)] : []),
    ...(creditsDone.length ? ['', dry ? 'WOULD BE CREDITED' : 'VENDOR CREDITS', ...creditsDone.map((r) => `  - ${r.vendor_name || ''} | ${r.credit_number || r.invoice_number || ''} | PO ${r.po_number || ''} | ${r.bill_number ? `bill ${r.bill_number}` : 'NOT linked to any bill'} | £${money(r.invoice_gross)}`)] : []),
    ...orderedGroups.flatMap(([code, rows]) => ['', `${title(code).toUpperCase()} (${rows.length}): ${(REASONS[code] || {}).action || ''}`, ...rows.map((r) => `  - ${r.file_name} | ${r.vendor_name || ''} | ${r.invoice_number || ''} | ${r.po_number || ''} | ${r.reason_text || ''} | waiting ${age(r.first_seen, day.until)}`)]),
    '', `${runs.length} runs · ${booksCalls} Books calls · ${aiCalls} AI reads · est. AI cost $${cost.toFixed(3)}`,
  ].join('\n');

  return { subject, html: h.join('\n'), text, to: config.report.to, cc: config.report.devCopy, from: config.report.from, counts: { billed: billsDone.length, credited: creditsDone.length, attention: attention.length, duplicates: dupes.length, new: newToday.length } };
}

function idx(code) { const i = ORDER.indexOf(code); return i < 0 ? 99 : i; }
function title(code) { return String(code || 'OTHER').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()).replace(/\b(po|ai|mpn|vat)\b/gi, (w) => w.toUpperCase()); }
function tile(label, value, sub, color) {
  return `<td width="25%" style="padding:4px"><div style="background:#f7f9fb;border:1px solid #e3e8ef;border-top:3px solid ${color};border-radius:6px;padding:10px 12px"><div style="font-size:11px;color:#52606d;text-transform:uppercase;letter-spacing:.05em">${esc(label)}</div><div style="font-size:24px;font-weight:600;color:#1f2933;margin-top:2px">${esc(value)}</div><div style="font-size:12px;color:#7b8794">${esc(sub)}</div></div></td>`;
}
function section(t, n, color) { return `<h3 style="margin:22px 0 8px;font-size:15px;color:${color}">${esc(t)} <span style="color:#7b8794;font-weight:400">(${n})</span></h3>`; }
function tableOpen(cols) { return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px"><tr style="background:#f3f5f8;color:#52606d">${cols.map((c) => `<th align="${c === 'Total' ? 'right' : 'left'}" style="padding:6px 8px;font-weight:600;font-size:12px">${esc(c)}</th>`).join('')}</tr>`; }
function td(v, align = 'left') { return `<td align="${align}" style="padding:6px 8px;border-top:1px solid #edf0f3;vertical-align:top">${v === undefined || v === null ? '' : v}</td>`; }
function link(href, label) { return href ? `<a href="${esc(href)}" style="color:#2f6fb3;text-decoration:none">${esc(label)}</a>` : esc(label); }
function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function money(n) { const x = Number(n); return Number.isFinite(x) ? x.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function age(iso, until) {
  if (!iso) return '';
  const days = Math.floor((new Date(until).getTime() - new Date(iso).getTime()) / 86400000);
  return days <= 0 ? 'today' : days === 1 ? '1 day' : `${days} days`;
}

module.exports = { buildDailyReport, dayRange };
