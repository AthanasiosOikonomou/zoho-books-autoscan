# AutoScan v2 — Architecture

Zoho Books invoice-to-bill automation, rebuilt on Zoho Catalyst with Claude for document reading.
Status: design baseline for the Phase 1 + Phase 2 build.

---

## 1. Components — who does what

| Component | Role | Notes |
|---|---|---|
| **Zoho Books** (EU DC) | System of record: Documents inbox, Purchase Orders, Bills, Vendors, Items, Payment terms | No business data is stored anywhere else. We read the inbox and write bills — nothing more. |
| **Zoho Catalyst** (EU DC, the client's account) | Orchestration: Cron → Job function `autoscan-run`; Data Store (`document_state`, `run_log`); Mail; env vars/secrets | Node.js. Replaces the old Deluge scheduled function entirely. |
| **Claude API** (Haiku 5.5) | Reads one PDF/image, returns strict JSON | Reads only. Takes no decision. |
| **Email** → finance inbox | The only UI finance needs | Per-run report with links into Books. |

---

## 2. End-to-end flow

```
 Supplier ──email──► finance inbox ────────────────────auto-forward──► Zoho Books › Documents › Inbox
                                                                                   │
   Catalyst Cron  (Mon–Fri 07:00–19:00 UK, every 30 min)                           │
        │                                                                          │
        ▼                                                                          │
   ┌─ autoscan-run (Job function, hard limit 15 min, we budget 10) ────────────────┼─────────────┐
   │                                                                               ▼             │
   │  0. LOCK      run_log has a RUNNING run < 15 min old? → exit (no overlap)                   │
   │  1. CONFIG    env vars + payment terms (1 Books call) → in memory for the whole run          │
   │  2. SCAN      GET documents?view=inbox, page 1..n until has_more_page=false                   │
   │               skip docs linked to a transaction; diff against document_state                │
   │               → NEW list (never seen)      → EXCEPTION list (seen, failed, retry-eligible)   │
   │  3. PASS A    NEW docs, oldest first, max 40 per run, concurrency 3 ─────► per-doc pipeline  │
   │  4. PASS B    EXCEPTION docs: last_attempt > 12h, attempts < 5, max 20 ──► per-doc pipeline  │
   │               (re-uses stored extraction — zero Claude calls)                                │
   │  5. REPORT    if anything happened: Mail → finance inbox (+ dev copy)                         │
   │  6. CLOSE     run_log: counts, Books calls, Claude tokens, est. cost, status DONE            │
   └───────────────────────────────────────────────────────────────────────────────────────────┘
```

### Per-document pipeline

```
 ┌────────────┐   ┌──────────────┐   ┌─────────────┐   ┌───────────┐   ┌─────────┐   ┌────────────────────┐
 │ DOWNLOAD   │──►│ EXTRACT      │──►│ RESOLVE PO  │──►│ DEDUPE    │──►│ MATCH   │──►│ BILL               │
 │ 1 Books    │   │ Claude, 1    │   │ 1–3 Books   │   │ 1 Books   │   │ 0 calls │   │ editpage → create  │
 │ call; mime │   │ call; JSON   │   │ exact → PO- │   │ vendor +  │   │ Phase 1 │   │ → (open) → attach  │
 │ from magic │   │ stored on    │   │ → PO-00xxx  │   │ invoice   │   │ totals  │   │ → verify → delete  │
 │ bytes      │   │ document_    │   │ → IPO/ →    │   │ number    │   │ Phase 2 │   │ 4–5 Books calls    │
 │            │   │ state        │   │ reference#  │   │           │   │ lines   │   │                    │
 └────────────┘   └──────────────┘   └─────────────┘   └───────────┘   └─────────┘   └────────────────────┘
        │                │                  │                │              │                  │
        ▼                ▼                  ▼                ▼              ▼                  ▼
   any failure → document_state = EXCEPTION(reason_code) → stays in Inbox → appears in report → retried in Pass B
   success     → document_state = BILLED(bill_id)        → Inbox file deleted → "new bill" line in report
```

### Outcome table

| Situation | reason_code | Books action | Inbox file | Retry |
|---|---|---|---|---|
| All good | — (BILLED) | Bill created Open, PDF attached | Deleted | — |
| AI could not find a PO reference / low confidence | NO_PO_REF | None | Stays | Pass B (after finance adds ref? usually manual) |
| Reference found but no such PO in Books | PO_NOT_FOUND | None | Stays | Pass B — finance creates/fixes PO |
| Total differs > £0.02 (Phase 1) | TOTAL_MISMATCH | None | Stays | Pass B — finance fixes PO |
| Bill with this supplier invoice no. already exists | DUPLICATE | None | Stays (flagged, never deleted) | No |
| Document > page cap or unreadable | PAGE_LIMIT / UNREADABLE | None | Stays | No — manual |
| Claude / Books API error | AI_ERROR / BOOKS_ERROR | None | Stays | Pass B automatically |
| Bill created but attachment failed | BILLED_NO_ATTACH | Bill exists | Stays | Pass B attaches only (dedupe prevents a second bill) |
| Phase 2: line without MPN / unmatched line / qty over remaining / price outside tolerance (incl. a product surcharge the PO price does not contain) / carriage above the PO beyond the vendor rule | NO_MPN / LINE_UNMATCHED / QTY_EXCEEDS / PRICE_MISMATCH / CARRIAGE_MISMATCH | None | Stays | Pass B |

Finance's "retry" is: fix the PO (or vendor rule) in Books. Nothing to click. The next Pass B picks it up.

---

## 3. Data model (Catalyst Data Store)

```
document_state
  document_id       PK (Books document_id)
  file_hash         sha256 of the binary → same file re-uploaded = reuse extraction, no AI call
  file_name, mime, pages
  status            NEW | BILLED | EXCEPTION | DUPLICATE | BILLED_NO_ATTACH
  reason_code, reason_text     (on a BILLED / WOULD_BILL row: reason_code empty, reason_text = the billing notes shown in the digest)
  attempts, first_seen, last_attempt
  vendor_id, po_id, bill_id
  extraction_json   Claude output (text)
  model, tokens_in, tokens_out
  run_id

run_log
  run_id PK, started, finished, status RUNNING|DONE|FAILED
  docs_seen, new, billed, exceptions, retried, errors
  books_calls, claude_calls, tokens_in, tokens_out, est_cost_usd
  report_sent
```

Queries are run-level (`WHERE status = 'EXCEPTION' AND last_attempt < ?`), never per-document lookups in a loop → a handful of SELECTs per run.

---

## 4. Decision logic (deterministic — no AI in anything that touches money)

**Resolve PO** — try in order, stop at first hit: exact `purchaseorder_number` → `PO-` + digits → zero-padded `PO-00xxx` → legacy `IPO/xxxxxx` → `reference_number`. Cheapest/most likely first, so most invoices cost one search call.

**Dedupe** — `bills?vendor_id=X&bill_number=<supplier invoice no.>`. "The PO already has a bill" is **not** a duplicate signal.

**One PO, many bills (business rule).** Suppliers ship a PO in parts and invoice each shipment. Every supplier invoice becomes its own bill linked to the same PO; the PO moves to *partially billed* and then *billed* as Books accumulates `quantity_billed` per line. The only duplicate is the same supplier invoice number for the same vendor.

- Phase 1 limitation: with total-vs-total matching a partial invoice cannot match and lands as TOTAL_MISMATCH (finance bills it by hand, as today). Included improvement: also compare the invoice against the PO's *remaining* value, so the closing invoice of a PO that finance partially billed manually still auto-matches.
- Phase 2 removes the limitation: line matching + partial bill creation.

**Match, Phase 1** — `|invoice gross − PO total| ≤ £0.02` (config).

**Match, Phase 2** (as built; rules of 6 and 16 Nov 2026) — per invoice line:

1. **Line → PO line** by the supplier's code: item custom field *Supplier Reference*, then item MPN (`part_number`), then SKU / item code, all normalised. **Value fallback** (`LINE_VALUE_FALLBACK`): an invoice line with no code match takes a PO line only if that line's item has no supplier-side code (no Supplier Reference, no MPN), it is the *one* open line with the same unit price to the penny (or the same money as a whole pack) and enough open quantity, no other invoice line could take it, and the two descriptions share a word. The match is noted with the code to add to the item. Anything ambiguous → `LINE_UNMATCHED`.
2. **Price**: up to 5 % below the PO → billed at the invoice price; any increase → `PRICE_MISMATCH`. A **product surcharge** on the invoice (`SURCHARGE_IN_PRICE`; a charge whose description says surcharge / levy without naming the delivery) is part of the product price: it is spread over the product lines by value before this check, so a surcharge the PO price already contains lands on the PO price and one it does not contain is a price increase.
3. **Quantity** ≤ ordered − already billed (pack ↔ each recognised).
4. **Carriage** (delivery charges only) against what is still open on the PO's carriage line: at or below the PO → accepted under every rule and billed as invoiced on that line for its whole open quantity, so the line and the PO complete (`CARRIAGE_BELOW_PO_OK`); none invoiced → nothing billed for carriage, the PO stays partially billed for the supplier's separate carriage invoice; a **carriage-only invoice** bills just that line. Above the PO the vendor rule decides (Zero: never / Fixed: up to the tolerance / Ignore: always); with no open carriage line (none on the PO, or already billed by an earlier shipment) accepted carriage becomes a line of its own.

VAT separate. All lines must match or the whole document is an exception with per-line detail. Web-shop purchase orders are treated like any other (no PO-level override).

**Bill** — `GET bills/editpage/frompurchaseorders` → set Bill# = supplier invoice no., date = invoice date (fallback today), terms from PO (by id), quantities = invoiced (partial allowed; Books tracks `quantity_billed` natively) → `POST bills` → ensure Open → attach → **verify** → delete inbox file → state BILLED.

Write order is deliberate: nothing is deleted until the attachment is verified.

---

## 5. Cost & performance — Zoho Books API

| Step | Calls (success) | Calls (exception) |
|---|---|---|
| Download | 1 | 1 |
| PO search + get | 2 (worst 4) | 2–4 |
| Dedupe | 1 | 1 |
| Vendor rule (Phase 2) | 0–1 (cached per vendor per run) | 0–1 |
| editpage + create + open + attach + delete | 4–5 | 0 |
| **Per invoice** | **≈ 9–10** | **≈ 4–6** |

- 150 invoices/day ≈ **1,500–1,700 calls/day** + inbox polling (24 runs × 1–2 pages ≈ 50). Books caps: Standard 2,000/day (too tight), Professional 5,000, Premium+ 10,000. → **Professional or above.**
- Per-minute cap 100/org → token-bucket limiter at **80/min**, concurrency 3. Measured need at full speed ≈ 30–40/min.
- Avoided waste vs the old script: no second download, no re-reading the backlog every run, no blind PO searches, payment terms fetched once per run not per document.
- Daily-limit guard: on a limit error the run stops cleanly, reports "API limit reached — resuming next run", leaves everything NEW.

## 6. Cost & performance — Claude

- **Model:** Haiku 5.5 ($0.10 / $0.50 per M tokens, ≤100k-token requests). Sonnet is a config switch, OFF.
- **Per document:** 1–2 pages ≈ 4–6k input tokens + system prompt ≈ 4k (cached: 1/10 price) + ≤ 600 output (`max_tokens` capped). ≈ **$0.001 per invoice**.
- **Monthly (2,000–3,000 docs): ≈ $2–5.** Workspace spend cap $30, alert $15.
- **Prompt caching:** system prompt marked `cache_control`; docs are processed back-to-back inside a run so the 5-minute cache is hit for every doc after the first.
- **Zero-waste rules:** extraction stored → retries never re-call; `file_hash` → re-uploaded duplicates never re-call; page cap (default 6) → statements/catalogues go to manual review instead of burning tokens; `tool_choice` forced → no prose, no parsing, no retries for bad JSON.
- **Latency:** ≈ 3–8 s per document on Haiku. Rate limits irrelevant at this volume (Start tier: 1,000 RPM).
- Retry on 429/529 with backoff, two failures → AI_ERROR (Pass B retries later).

## 7. Cost & performance — Catalyst

- **Function:** Job, 256 MB. Per document ≈ 10–12 s wall time (Claude + ~7 Books calls); concurrency 3 → **40 new docs ≈ 2.5–3 min**. Caps (40 new + 20 retries) keep every run well under the **15-min Job limit**; the run also watches `getMaxExecutionTimeMs()` and stops taking new docs at 70% budget — the rest stays NEW for the next run 30 min later.
- **Backlog maths:** 200-document backlog drains in ~5 runs ≈ 2.5 h, while new invoices keep flowing (Pass A always first).
- **GB-seconds:** 150 docs × 12 s × 0.25 GB ≈ 450/day ≈ **10k/month** (free tier 25k). Empty runs exit in ~2 s.
- **Data Store:** per doc 1 INSERT + 2–3 UPDATE; run-level SELECTs. ≈ 10k ops/month, mostly inside free tiers. The **$5/project minimum** is effectively the Catalyst bill.
- **Mail:** only runs with activity email; ≈ 300–500/month ≈ $0.50. Optional 18:00 daily digest instead of per-run.
- **Cron:** business hours only (Mon–Fri 07:00–19:00) = 24 runs/day; nothing to process at night.

**Total platform running cost ≈ $8–12/month** (Claude $2–5 + Catalyst $5 + Books $0 on an existing plan).

---

## 8. Reliability & safety

- **Idempotent by design:** document_id state + vendor/invoice-number dedupe + file hash. Re-running a run, re-uploading a file, or a crash mid-run never produces a second bill or a second attachment.
- **Overlap lock** in run_log; runs are short, so the cron never stacks.
- **Per-document isolation:** one failure marks that document and the loop continues; the run always ends with a report (the old script died silently).
- **Order of writes:** create bill → attach → verify → delete. A failed attach leaves BILLED_NO_ATTACH, retried as attach-only.
- **Dry-run flag:** full pipeline, full report, zero writes to Books — used for testing on the live org (no sandbox) and for UAT.
- **Feature flags:** Phase 2 line matching per vendor; model switch; caps and tolerances in env vars — no redeploy to tune.
- **Secrets:** Claude key and Books connection in Catalyst secrets, created by the integrator inside the client's accounts; never in code, never emailed.
- **Data:** supplier invoices (business data) go to Claude for reading only; extraction JSON stays in Catalyst EU; logs carry document_id and reason codes, not invoice content.
- **Monitoring:** run_log per run; FAILED run → alert to dev mailbox; weekly token/cost line in the report.

---

## 9. What finance sees

One email per run with activity (subject carries counts), containing: new bills (links), exceptions grouped by reason with file name, supplier, what was read vs what the PO says, link to the PO and to the inbox document, and a one-line "what to do" per reason. After fixing a PO they do nothing else — the next run re-checks it.

---

## 10. Build order (maps to the Zoho Projects tasks)

1. Kickoff, access, data audit, golden set, design sign-off
2. Catalyst / Books / Claude environments
3. Phase 1: Books client → queue → extraction → matching → bill → report → golden-set tests → dry-run → UAT → go-live → 2-week hypercare
4. Phase 2 (gated on MPN data): vendor rules → line matching → partial bills → tests → UAT → go-live
5. Documentation and handover
