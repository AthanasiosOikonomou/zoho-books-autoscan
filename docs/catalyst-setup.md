# Catalyst setup (Development environment)

One-time setup to run `autoscan-run` on a schedule in the client's Catalyst project. Do everything in the **Development** environment first.

## 1. CLI

```bash
npm i -g zcatalyst-cli
catalyst login --force --dc eu      # browser login as the user invited to the client's project (--force replaces any other login)
catalyst whoami                     # must show that user, not another account
```

The CLI holds **one** global login. Switching to another project later = `catalyst login --force` again. Optional: `catalyst token:generate` → `CATALYST_TOKEN=...` in `.env` makes `npm run deploy` pass `--token`, so this repo keeps deploying as this user even after the global login changes.

## 2. Link this repo to the project

`catalyst.json` (which function to deploy) is committed. `catalyst init` only has to write `.catalystrc` (org / project / environment ids — git-ignored):

```bash
cd ~/repos/<this repo>
catalyst init
#   organization → the client's
#   project      → the client's existing project (pick it from the list; never "create a new project")
#   features     → select NOTHING, just press Enter (if it insists: Functions → Job → NodeJS 20 → name tmp_init → install deps No,
#                  then rm -rf functions/tmp_init)
git checkout catalyst.json          # in case init rewrote it
git status                          # only .catalystrc may be new (and it is ignored) — nothing else should have changed
```

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

## 4. Report email

Two transports, chosen by `MAIL_TRANSPORT` in `.env`:

**`smtp` (default, no Catalyst verification)** — the function sends through any SMTP mailbox with nodemailer. For Zoho Mail: accounts.zoho.eu → Security → **App Passwords** → generate one for "AutoScan" → `.env`:

```
MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.zoho.eu     # 465 + SMTP_SECURE=true (implicit TLS); or 587 + SMTP_SECURE=false (STARTTLS)
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=<the mailbox>
SMTP_PASS=<app password>
```

The From address is `SMTP_USER` (Zoho Mail rejects any other From unless it is an alias of that mailbox). Development: a mailbox you control. Production: a mailbox the client owns (e.g. a no-reply/finance address) with its own app password — the client generates it, you paste it into `.env`.

**`catalyst`** — Catalyst Mail (`app.email().sendMail`). Needs Console → **Mail → Senders**: either a verified individual sender or a verified domain (DNS TXT). Set `MAIL_TRANSPORT=catalyst` and `REPORT_FROM=<verified sender>`. Use this if the client prefers to verify their domain at go-live.

## 5. Environment variables + deploy

Env vars travel **inside** `functions/autoscan-run/catalyst-config.json` and `catalyst deploy` replaces the function's variables with that file's contents every time (anything set in the Console is wiped). So the file is generated from `.env` and never committed:

```bash
npm run catalyst-config          # writes functions/autoscan-run/catalyst-config.json from .env (prints names only)
npm run deploy                   # = catalyst-config + catalyst deploy --only functions
```

Keep `DRY_RUN=true` in `.env` until UAT sign-off; the deployed job then reports but never writes to Books.

## 6. Job pool + first run

Job functions run through **Job Scheduling** (there is no Execute button on the function):

1. Console → **Job Scheduling → Job Pools → Create**: name `autoscan-pool`, type *Function*, memory 512 MB, capacity 1.
2. **Job Scheduling → Jobs → Submit Job**: pool `autoscan-pool`, function `autoscan-run`, params `{}`.
3. **Logs** (DevOps → Logs, component Functions → `autoscan-run`, last hour) — Job logs arrive with a 1–3 min delay. Expect `run.scan` … `run.done`, then the text report (`MAIL_TRANSPORT=log`).
4. `run_log` has a row with status DONE; `document_state` has one row per inbox document, none left in `PROCESSING`.

A run that is skipped with `run.skipped_active_run` means a `run_log` row is still `RUNNING` from a run younger than `LOCK_STALE_MINUTES` (15) — wait, or set that row's status to FAILED.

## 7. Cron

**Job Scheduling → Crons → Create**: name `autoscan-every-30m`, *Periodic*, every 30 minutes, target pool `autoscan-pool` → function `autoscan-run`, enable. Restrict to business hours if the UI allows (Mon–Fri 07:00–19:00 Europe/London); otherwise leave 24/7 — an empty run costs nothing measurable (a few ZCQL calls, no Claude call).

## 8. Promote to Production (go-live, later)

Create the same two tables in Production, switch `.env` to production values (Books org, production API key named `autoscan-production` from a **service account**, `REPORT_TO` = the finance inbox, the client's own SMTP mailbox + app password (or `MAIL_TRANSPORT=catalyst` with their verified domain), `DRY_RUN=false`), `npm run deploy` against Production, enable the cron, and switch off the old Deluge schedule.
