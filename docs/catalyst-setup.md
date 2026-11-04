# Catalyst setup (Development environment)

One-time setup to run `autoscan-run` on a schedule in the client's Catalyst project. Do everything in the **Development** environment first.

## 1. CLI

```bash
npm i -g zcatalyst-cli
catalyst login --force --dc eu      # browser login as the user invited to the client's project (--force replaces any other login)
catalyst whoami
catalyst token:generate             # → CATALYST_TOKEN=... in .env ; deploys then use this identity even if the global login changes
```

The CLI holds one global login. With `CATALYST_TOKEN` in `.env`, `npm run deploy` passes `--token` on every command, so you can log the CLI back into another project afterwards (`catalyst login --force`) without breaking this repo.

## 2. Link this repo to the project

`catalyst init` is interactive and insists on creating a function. Let it create a throwaway one, then point it at ours:

```bash
cd ~/repos/<this repo>
catalyst init
#   organization → the client's
#   project      → the client's existing project (pick from the list; do NOT create a new one)
#   features     → Functions only
#   function     → type: Job, runtime: Node 20, name: tmp_init  (anything — it gets deleted)
#   install deps → No
rm -rf functions/tmp_init
```

Then edit `catalyst.json` → `functions.targets` to `["autoscan-run"]` (keep `"source": "functions"`). `.catalystrc` now holds the project/env ids — it is git-ignored, keep it that way.

## 3. Data Store tables

Console → the project → Development → **Data Store → New Table**. Column names are case-sensitive and must match exactly.

### `document_state`

| Column | Type | Notes |
|---|---|---|
| document_id | Text, max 50 | Books document_id — mark as **unique** if the console offers it |
| file_hash | Text, max 64 | sha256 |
| file_name | Text, max 255 | |
| mime | Text, max 50 | |
| pages | Integer | |
| status | Text, max 30 | NEW / BILLED / EXCEPTION / DUPLICATE / BILLED_NO_ATTACH / WOULD_BILL / PROCESSING |
| reason_code | Text, max 40 | |
| reason_text | Text, max 1000 | |
| attempts | Integer | |
| first_seen | DateTime | UTC |
| last_attempt | DateTime | UTC |
| vendor_id | Text, max 50 | |
| vendor_name | Text, max 255 | |
| po_id | Text, max 50 | |
| po_number | Text, max 50 | |
| bill_id | Text, max 50 | |
| bill_number | Text, max 100 | |
| invoice_number | Text, max 100 | |
| invoice_date | Text, max 10 | |
| invoice_gross | Double | |
| extraction_json | Text, max **10000** | the AI output; line items are dropped if it would exceed this |
| prompt_version | Text, max 20 | |
| model | Text, max 60 | |
| tokens_in | Integer | |
| tokens_out | Integer | |
| run_id | Text, max 40 | |
| claimed_run_id | Text, max 40 | |

### `run_log`

| Column | Type |
|---|---|
| run_id | Text, max 40 |
| started | DateTime |
| finished | DateTime |
| status | Text, max 20 |
| docs_seen, new_count, billed, exceptions, retried, errors, books_calls, claude_calls, tokens_in, tokens_out | Integer (one column each) |
| est_cost_usd | Double |
| report_sent | Boolean |
| notes | Text, max 1000 |

The function initialises the SDK with `scope: 'admin'`, so no table permission changes are needed.

## 4. Mail sender

Console → **Mail → Senders** → add the address the report is sent from (`REPORT_FROM` in `.env`) and complete the verification email. During testing use a mailbox you control; production uses an address the client owns.

## 5. Environment variables + deploy

Env vars travel **inside** `functions/autoscan-run/catalyst-config.json` and `catalyst deploy` replaces the function's variables with that file's contents every time (anything set in the Console is wiped). So the file is generated from `.env` and never committed:

```bash
npm run catalyst-config          # writes functions/autoscan-run/catalyst-config.json from .env (prints names only)
npm run deploy                   # = catalyst-config + catalyst deploy --only functions
```

Keep `DRY_RUN=true` in `.env` until UAT sign-off; the deployed job then reports but never writes to Books.

## 6. Cron

Console → **Cron → New Cron** → name `autoscan-every-30m` → type *Function* → function `autoscan-run` → *Periodic*, every 30 minutes → restrict to business hours if the UI allows (Mon–Fri 07:00–19:00 Europe/London), otherwise leave 24/7 (empty runs cost nothing measurable).

## 7. First run

Trigger the job once from the Console (Functions → autoscan-run → Execute / Logs) and check:

- Logs show `run.scan`, `run.done`
- `run_log` has a row with status DONE
- `document_state` has one row per inbox document
- the report email arrived at `REPORT_TO`

## 8. Promote to Production (go-live, later)

Create the same two tables and the Mail sender in Production, switch `.env` to production values (Books org, production API key named `autoscan-production` from a **service account**, `REPORT_TO` = the finance inbox, `DRY_RUN=false`), `npm run deploy` against Production, enable the cron, and switch off the old Deluge schedule.
