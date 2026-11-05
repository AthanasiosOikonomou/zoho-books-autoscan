# zoho-books-autoscan

Zoho Books supplier-invoice → bill automation, running on **Zoho Catalyst** (EU DC, the client's account) with **Claude** for document reading. Replaces a previous Deluge scheduled function.

> Status (5 Nov 2026): **Phase 1 and Phase 2 deployed and proven** on the client's Catalyst project (Development env) against the Books sandbox — scan → read → match → bill (at the invoice total) → report, automatic reconciliation, de-duplication, **credit notes → vendor credits** (applied to the bill, PDF attached), the **once-a-day HTML digest**, and **line-by-line matching** (Supplier Reference / MPN / SKU, partial deliveries, vendor carriage rules) — all verified live. The 13-document golden set of real supplier invoices reads correctly. The digest goes to the function log until the client provides a mailbox. Production stays in **dry-run** until UAT sign-off.

**Next:** client's answer on the price policy (per-line tolerance, accept-lower-price) → report mailbox → UAT with finance → production promotion.

## What it does

Every 30 minutes a Catalyst Job function reads the Zoho Books **Documents inbox**, sends each new PDF/JPG/PNG to Claude (Haiku, forced JSON schema, ≈ $0.001 per document), resolves the purchase order it references, checks the invoice total against the PO (or the PO's remaining value when it was part-billed) within **£1**, and creates the **bill from the PO** in Books — bill number = supplier invoice number, bill date = invoice date, bill total = **the invoice total** (any pence difference to the PO-priced lines is posted as the bill's adjustment), the PDF attached, the inbox file deleted only after the attachment is verified. Everything else becomes a reviewable exception with a reason code and an action for finance.

Exceptions are **reconciled automatically**: a document whose PO was missing or wrong is re-checked every 6 h for a week (28 attempts) using the stored extraction — no second AI call — so fixing the PO hours or days later bills it without anyone touching the inbox. Service errors (AI, Books, attachment) retry on the next run. Duplicate supplier invoice numbers are never billed twice; a PO can receive several bills (partial deliveries).

**Phase 2 (`PHASE2_ENABLED=true`) matches line by line.** Each invoice line is matched to a PO line by the supplier's code — the item custom field *Supplier Reference* printed on the PO, the item MPN, or the SKU — compared normalised (`ZK410-KIT` = `ZK410KIT`). Quantity must not exceed what is still un-billed on that PO line (partial deliveries bill only what was shipped; the rest waits for the next invoice), the unit price must be within `LINE_PRICE_TOLERANCE_PCT` (a lower price is accepted and billed as invoiced when `ACCEPT_LOWER_PRICE`), and carriage is checked under the **vendor's rule** — `Carriage Rule` Zero / Fixed (± `Carriage Tolerance`) / Ignore, two custom fields finance maintains on the vendor; default Zero. The bill then carries exactly the invoice: invoiced quantities, invoice prices, invoice carriage. A PO whose lines carry no code at all falls back to the total match and the report says so (`NO_MPN`).

**Credit notes** become Books **vendor credits**: lines mapped to the PO's lines by MPN, the credit applied to the bill it refers to (by the invoice number printed on it, or the PO's only bill), otherwise left against the PO and reported as *not linked to any bill*. Same credit-note number twice → duplicate.

**Reporting**: every run writes its report to the function log; finance gets **one email per day** — an HTML dashboard with bills created (links into Books), vendor credits, everything still waiting for a human grouped by reason with the action to take and how long it has been waiting, duplicates, and the day's API/AI cost. Sent by the first run after `DAILY_REPORT_HOUR`, or on demand (`docs/catalyst-setup.md` §7b).

## Layout

| Path | What |
|---|---|
| `functions/autoscan-run/` | The Catalyst **Job** function (cron-triggered). All runtime code lives in `src/`. |
| `functions/autoscan-run/src/pipeline/` | `run.js` (lock → scan → pass A/B → report), `processDocument.js` (one document end to end), `resolvePo.js`, `match.js`, `bill.js`, `reasons.js` |
| `functions/autoscan-run/src/books/` | Books v3 client (rate-limited, retried) + OAuth refresh |
| `functions/autoscan-run/src/claude/` | Extractor, tool schema, `prompt.v7.md` |
| `functions/autoscan-run/src/state/` | `document_state` / `run_log` store (Catalyst Data Store in prod, JSON file locally) |
| `functions/autoscan-run/src/report/` | Run report (HTML + text) and mailers |
| `functions/autoscan-run/test/` | `node --test` unit + fake-backed pipeline tests |
| `scripts/` | `books-token.js`, `books-probe.js`, `seed-sandbox.js`, `make-test-invoices.js`, `local-run.js` |
| `docs/` | Architecture, decisions, client requirements, Catalyst setup |
| `functions/autoscan-run/src/pipeline/lines.js`, `vendorRules.js` | Phase 2 line matcher and the vendor carriage rule reader |

## Setup (sandbox)

```bash
npm install            # root tooling + (postinstall) the function's own dependencies
cp .env.example .env
```

1. **Books token** — api-console.zoho.eu → Self Client → Generate Code, scope `ZohoBooks.fullaccess.all`, 10 min. Fill `BOOKS_CLIENT_ID/SECRET` in `.env`, then
   `npm run token -- <code>` → paste `BOOKS_REFRESH_TOKEN` into `.env`.
2. **Pick the sandbox org** — `npm run probe -- orgs` → set `BOOKS_ORG_ID` *and* `SEED_ALLOW_ORG_ID` to the sandbox id. `npm run probe` to confirm (terms, inbox, POs).
3. **Claude key** — create it in the client's Anthropic Console workspace → `ANTHROPIC_API_KEY`. Set `CLAUDE_MODEL` to the current Haiku id.
4. **Seed** — `npm run seed -- --plan` then `npm run seed` (vendors, items, POs for every scenario). Then in the Books UI create the vendor custom fields *Carriage Rule* / *Carriage Tolerance* (Phase 2).
5. **Test invoices** — `npm run invoices` → `seed/invoices/*.pdf` + `manifest.json` (expected outcome per file). Upload them to the sandbox Documents inbox.
6. **Run** — `npm run run` (dry-run; report written to `out/`). Repeat: known documents are not re-read. `--live` requires `DRY_RUN=false` in `.env`.

## Tests

```bash
npm test
```

The pipeline tests prove with fakes: new documents processed first; exceptions never re-extracted and only retried after `RETRY_AFTER_HOURS`; dry-run writes nothing; duplicate supplier invoice numbers are never billed twice; a PO with an existing bill still gets a new bill for a different invoice; same file re-uploaded reuses the extraction; the bill is posted with the invoice total (adjustment) and a differing bill total is flagged; credit notes become vendor credits applied to the right bill (or the PO only, reported), de-duplicated, removed again when Books prices them differently; the daily digest goes out once per local day; stale claims from a dead run and transient errors are retried.

## Deploy (Catalyst, Development env)

See [`docs/catalyst-setup.md`](docs/catalyst-setup.md) for the one-time setup (CLI, `catalyst init`, Data Store tables, report email (SMTP or Catalyst Mail), cron). After that:

```bash
npm run deploy        # generates functions/autoscan-run/catalyst-config.json from .env (env vars ride inside it) and deploys the function
```

`catalyst-config.json` is git-ignored because it carries the real environment variables; `catalyst-config.example.json` is the committed template.

## Outcomes and reason codes

| Status / reason | Meaning | Retried |
|---|---|---|
| `BILLED` | Bill created from the PO, PDF attached, inbox file deleted | — |
| `WOULD_BILL` | Same, but `DRY_RUN=true` — nothing written | yes |
| `CREDITED` / `WOULD_CREDIT` | Vendor credit created from a credit note (applied to the bill when identifiable) | — / yes |
| `DUPLICATE` | A bill with this supplier invoice number already exists for the vendor | no |
| `TOTAL_MISMATCH` | Invoice total differs from the PO (or its remaining value) by more than the tolerance | every 6 h |
| `PO_NOT_FOUND` / `NO_PO_REF` | PO reference not in Books / not readable on the document | every 6 h |
| `BILL_TEMPLATE_MISMATCH` | Books would bill a different figure from the PO's remaining quantities | every 6 h |
| `LOW_CONFIDENCE` | The reader was unsure; values shown for review | every 6 h |
| `LINE_UNMATCHED` / `QTY_EXCEEDS` / `PRICE_MISMATCH` / `CARRIAGE_MISMATCH` | Phase 2: invoice line not on the PO / more than remaining / price outside tolerance / carriage outside the vendor rule | every 6 h |
| `NO_MPN` | Phase 2 could not use the PO lines (no Supplier Reference / MPN / SKU) — matched on totals instead | — (note) |
| `CREDIT_NOTE` / `CREDIT_TOTAL_MISMATCH` | Credit note unreadable / Books priced the credit differently from the printed total (draft removed) | no / every 6 h |
| `NOT_AN_INVOICE` / `UNSUPPORTED_FILE` / `PAGE_LIMIT` | Statement, delivery note, non-PDF, catalogue… | no |
| `AI_ERROR` / `BOOKS_ERROR` / `ATTACH_FAILED` | Service error | next run |

## Configuration

All tunables are environment variables (`.env` locally, Catalyst env vars deployed — see `.env.example`). The ones finance will care about: `TOTAL_TOLERANCE` (GBP, default 1.00), `BILL_ADJUST_TO_INVOICE` (default true), `RETRY_AFTER_HOURS` (6) × `MAX_ATTEMPTS` (28), `MAX_NEW_PER_RUN` (40), `DRY_RUN`, `MAIL_TRANSPORT` (`log` | `smtp` | `catalyst`), `DAILY_REPORT_HOUR` (17, `off` to disable), `REPORT_PER_RUN` (false), `PO_PREFIX` / `PO_PAD_WIDTH` (the Books PO numbering, e.g. `PR-` / 5).

## Backlog (agreed with the client, not started)

- **Report mailbox**: the daily email is built and verified; it goes to the log until the client provides a mailbox (`MAIL_TRANSPORT=smtp`, one deploy).
- **Price policy**: `LINE_PRICE_TOLERANCE_PCT` (5) and `ACCEPT_LOWER_PRICE` (true) are placeholders until the client confirms them — one env change, no code.
- **Golden set**: real supplier invoices from the client through the sandbox before UAT.

## Rules

- Secrets only in `.env` (local, git-ignored) and Catalyst environment variables. Never in code, never in chat, never in a commit.
- `DRY_RUN=true` until finance signs off UAT. The old Deluge schedule is switched off by the client at UAT.
- Nothing is deleted from the inbox unless a bill exists **and** the attachment is verified.
- The AI reads; the code decides. No model output reaches Books without passing `resolvePo` → dedupe → `matchTotals`.
- Catalyst ROWIDs are above 2^53: never take a ROWID from an insert/update response (it arrives as a rounded JSON number); read it back through ZCQL (`docs/decisions.md`).
