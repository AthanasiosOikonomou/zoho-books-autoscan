#!/usr/bin/env node
'use strict';

/**
 * Golden set: run the extractor (Claude only — no Books, no state) over the client's
 * real documents in ./golden and write what was read, for review and prompt tuning.
 *
 *   node scripts/golden.js                 → every PDF/JPG/PNG in ./golden (results cached by file hash)
 *   node scripts/golden.js --file "x.pdf"  → one file
 *   node scripts/golden.js --force         → re-read even if a cached result exists (costs AI calls)
 *
 * Output (git-ignored, under golden/_results):
 *   <file>.json      the full extraction + usage
 *   summary.md       one table row per document (open it, or paste it)
 *   summary.json     machine-readable
 * Nothing in ./golden is ever committed (see .gitignore).
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Anthropic = require('@anthropic-ai/sdk');
const fn = (p) => require(path.join(__dirname, '..', 'functions', 'autoscan-run', 'src', p));
const { loadConfig } = fn('config');
const { createLogger } = fn('logger');
const { createExtractor, estimateCostUsd } = fn('claude/extractor');
const { detectMime, isSupported, estimatePageCount } = fn('util/mime');
const { sha256 } = fn('util/hash');
const { candidatesFor } = fn('pipeline/resolvePo');

(async () => {
  const args = process.argv.slice(2);
  const only = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;
  const force = args.includes('--force');
  const config = loadConfig(process.env);
  if (!config.claude.apiKey) { console.error('ANTHROPIC_API_KEY missing in .env'); process.exit(2); }
  const dir = path.join(__dirname, '..', 'golden');
  const outDir = path.join(dir, '_results');
  fs.mkdirSync(outDir, { recursive: true });
  const logger = createLogger({ level: process.env.LOG_LEVEL || 'warn' });
  const extractor = createExtractor({ client: new Anthropic({ apiKey: config.claude.apiKey }), config: config.claude, poExample: config.matching.poExample, logger });

  const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.') && !f.startsWith('_') && (only ? f === only : true) && fs.statSync(path.join(dir, f)).isFile());
  if (!files.length) { console.error(`No documents in ${dir}`); process.exit(2); }
  const rows = [];
  let cost = 0; let calls = 0;
  for (const f of files.sort()) {
    const buffer = fs.readFileSync(path.join(dir, f));
    const mime = detectMime(buffer, f);
    const hash = sha256(buffer);
    const resultPath = path.join(outDir, `${f}.json`);
    let rec = null;
    if (!force && fs.existsSync(resultPath)) { try { rec = JSON.parse(fs.readFileSync(resultPath, 'utf8')); if (rec.file_hash !== hash || rec.prompt_version !== extractor.promptVersion) rec = null; } catch { rec = null; } }
    if (!rec) {
      if (!isSupported(mime)) { rows.push({ file: f, error: `unsupported ${mime}` }); continue; }
      const pages = estimatePageCount(buffer, mime);
      process.stdout.write(`reading ${f} (${mime}, ~${pages} page${pages === 1 ? '' : 's'}) … `);
      try {
        const out = await extractor.extract(buffer, mime);
        const c = out.usages.reduce((s, u) => s + estimateCostUsd(u), 0);
        rec = { file: f, file_hash: hash, mime, pages, prompt_version: extractor.promptVersion, model: out.usage.model, cost_usd: c, usages: out.usages, extraction: out.extraction, read_at: new Date().toISOString() };
        fs.writeFileSync(resultPath, JSON.stringify(rec, null, 2));
        calls++; cost += c;
        console.log(`ok $${c.toFixed(4)}`);
      } catch (err) { console.log(`FAILED ${err.message}`); rows.push({ file: f, error: err.message }); continue; }
    }
    const e = rec.extraction;
    rows.push({
      file: f, type: e.document_type, supplier: e.supplier_name, invoice_number: e.invoice_number, invoice_date: e.invoice_date,
      po_reference: e.po_reference, po_candidates: candidatesFor(e.po_reference, config.matching).slice(0, 4), related_invoice: e.related_invoice_number,
      net: e.totals.net, vat: e.totals.vat, carriage: e.totals.carriage, gross: e.totals.gross,
      lines: e.line_items.length, codes: e.line_items.map((l) => l.mpn).filter(Boolean).slice(0, 6), lines_without_code: e.line_items.filter((l) => !l.mpn).length,
      lines_sum: round2(e.line_items.reduce((s, l) => s + (Number(l.line_total) || 0), 0)),
      confidence: e.confidence, notes: e.notes, pages: rec.pages, cost_usd: rec.cost_usd, cached: !calls || rec.read_at < new Date(Date.now() - 60000).toISOString(),
    });
  }

  const md = [];
  md.push(`# Golden set — ${rows.length} documents — ${new Date().toISOString().slice(0, 16)}Z`, '');
  md.push(`Prompt ${extractor.promptVersion} · model ${config.claude.model} · AI calls this run: ${calls} · cost this run: $${cost.toFixed(4)}`, '');
  md.push('| # | File | Type | Supplier | Invoice # | Date | PO ref read | Net | VAT | Carriage | Gross | Lines (no code) | Σ lines | Conf. | Notes |');
  md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  rows.forEach((r, i) => {
    if (r.error) { md.push(`| ${i + 1} | ${esc(r.file)} | ERROR | ${esc(r.error)} |||||||||||`); return; }
    const sumFlag = r.net !== null && r.lines && Math.abs(r.lines_sum - r.net) > 0.05 ? ` ⚠ ≠ net` : '';
    md.push(`| ${i + 1} | ${esc(r.file)} | ${r.type} | ${esc(r.supplier)} | ${esc(r.invoice_number)} | ${r.invoice_date || ''} | ${esc(r.po_reference)} | ${num(r.net)} | ${num(r.vat)} | ${num(r.carriage)} | ${num(r.gross)} | ${r.lines} (${r.lines_without_code}) | ${num(r.lines_sum)}${sumFlag} | ${Math.round((r.confidence || 0) * 100)}% | ${esc(r.notes)} |`);
  });
  md.push('', '## Line codes read (first 6 per document)', '');
  for (const r of rows) if (!r.error) md.push(`- **${esc(r.file)}** → ${r.codes.length ? r.codes.map((c) => `\`${c}\``).join(', ') : '_none_'}${r.po_reference ? ` · PO candidates: ${r.po_candidates.map((c) => `\`${c}\``).join(', ')}` : ''}`);
  md.push('', '## Checks to do by eye', '', '- PO ref: is it the customer PO (PO-xxxxxx) and not the supplier\'s own order number?', '- Gross: equals the printed total incl. VAT?', '- Lines: every product line present, codes = the supplier\'s reference / MPN as printed?', '- Carriage: separated from the product lines?', '- Credit notes: type credit_note, related invoice read?', '');
  fs.writeFileSync(path.join(outDir, 'summary.md'), md.join('\n'));
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(rows, null, 2));
  console.log(`\n${rows.length} documents · ${calls} AI calls · $${cost.toFixed(4)} this run\n→ ${path.join(outDir, 'summary.md')}`);
})().catch((err) => { console.error(err); process.exit(1); });

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function num(n) { return n === null || n === undefined ? '' : Number(n).toFixed(2); }
function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }
