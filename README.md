# zoho-books-autoscan

Zoho Books supplier-invoice → bill automation, running on **Zoho Catalyst** (EU DC, the client's account) with **Claude** for document reading. Replaces a previous Deluge scheduled function.

> Status: Phase 1 scaffold. Everything runs in **dry-run** until UAT sign-off. Work in the Books **sandbox** org and the Catalyst **Development** environment only.

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
| `docs/` | Architecture, decisions |

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

The pipeline tests prove with fakes: new documents processed first; exceptions never re-extracted and only retried after `RETRY_AFTER_HOURS`; dry-run writes nothing; duplicate supplier invoice numbers are never billed twice; a PO with an existing bill still gets a new bill for a different invoice; same file re-uploaded reuses the extraction.

## Deploy (Catalyst, Development env)

See [`docs/catalyst-setup.md`](docs/catalyst-setup.md) for the one-time setup (CLI, `catalyst init`, Data Store tables, Mail sender, cron). After that:

```bash
npm run deploy        # generates functions/autoscan-run/catalyst-config.json from .env (env vars ride inside it) and deploys the function
```

`catalyst-config.json` is git-ignored because it carries the real environment variables; `catalyst-config.example.json` is the committed template.

## Rules

- Secrets only in `.env` (local, git-ignored) and Catalyst environment variables. Never in code, never in chat, never in a commit.
- `DRY_RUN=true` until finance signs off UAT. The old Deluge schedule is switched off by the client at UAT.
- Nothing is deleted from the inbox unless a bill exists **and** the attachment is verified.
- The AI reads; the code decides. No model output reaches Books without passing `resolvePo` → dedupe → `matchTotals`.
