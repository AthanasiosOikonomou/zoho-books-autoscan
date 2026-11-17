# Catalyst setup and deployment

One-time setup to run `autoscan-run` on a schedule in a Zoho Catalyst project, then how to deploy and how to promote to Production. Do everything in the **Development** environment against a Books **sandbox** first.

Variables mentioned here are described in [`configuration.md`](configuration.md); what a healthy run looks like and what to do when it is not is in [`operations.md`](operations.md).

## 0. Access you need

| Access | Needed for | Who grants it |
|---|---|---|
| Zoho Books user in the organisation, with a role that can read documents and purchase orders and create bills and vendor credits | Authorising the Self Client; creating custom fields | A Books administrator of the organisation |
| A Books sandbox organisation | All development and testing | A Books administrator |
| Zoho API console (Self Client) under that same user | `BOOKS_CLIENT_ID`, `BOOKS_CLIENT_SECRET`, the grant code | Available to the user once they can sign in |
| Collaborator on the Catalyst project | CLI deploy, Console (Data Store, Job Scheduling, Logs) | The owner of the Catalyst project |
| API key in an Anthropic Console workspace | `ANTHROPIC_API_KEY` | The owner of that workspace |
| A mailbox for sending the digest, with its password or an app password | `SMTP_USER`, `SMTP_PASS` | Whoever administers the organisation's mail |

One Self Client can serve both the sandbox and the production organisation when the same user has access to both.

## 1. CLI

```bash
npm i -g zcatalyst-cli
catalyst login --force --dc eu      # browser login as the user invited to the project (--force replaces any other login)
catalyst whoami                     # must show that user, not another account
```

Use the `--dc` of the project's data centre. The CLI holds **one** global login; switching to another project later means `catalyst login --force` again. To make this repository independent of the global login, run `catalyst token:generate` once and put the result in `.env` as `CATALYST_TOKEN` — `npm run deploy` then passes `--token`.

## 2. Link the repository to the project

`catalyst.json` (which function to deploy) is committed. `catalyst init` only has to write `.catalystrc` (organisation, project and environment ids — git-ignored):

```bash
catalyst init
#   organization → the one that owns the project
#   project      → the existing project (pick it from the list; never "create a new project")
#   features     → select NOTHING, just press Enter (if it insists: Functions → Job → NodeJS 20 → name tmp_init → install deps No,
#                  then remove functions/tmp_init)
git checkout catalyst.json          # in case init rewrote it
git status                          # only .catalystrc may be new (and it is ignored) — nothing else should have changed
```

## 3. Data Store tables

Console → the project → Development → **Data Store → New Table**. Column names are case-sensitive and must match exactly.

### `document_state`

| Column | Type | Notes |
|---|---|---|
| document_id | Text, max 50 | Books `document_id` — mark as **unique** if the Console offers it |
| file_hash | Text, max 64 | sha256 of the file |
| file_name | Text, max 255 | |
| mime | Text, max 50 | |
| pages | Integer | |
| status | Text, max 30 | PROCESSING / BILLED / BILLED_NO_ATTACH / EXCEPTION / DUPLICATE / WOULD_BILL / CREDITED / WOULD_CREDIT |
| reason_code | Text, max 40 | |
| reason_text | Text, max 1000 | Exception detail; on a billed row (empty reason_code): the billing notes shown in the daily digest |
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
| extraction_json | Text, max **10000** | The reading; line items are dropped if it would exceed this |
| prompt_version | Text, max 20 | |
| model | Text, max 60 | |
| tokens_in | Integer | |
| tokens_out | Integer | |
| run_id | Text, max 40 | |
| claimed_run_id | Text, max 40 | |
| credit_id | Text, max 50 | Vendor credit created from a supplier credit note |
| credit_number | Text, max 100 | |

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

Three transports, chosen by `MAIL_TRANSPORT`:

**`log` (default)** — no email; the text report goes to the function log. Enough to prove the pipeline before a mailbox exists.

**`smtp`** — the function sends through any SMTP mailbox with nodemailer. For Zoho Mail:

```bash
MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.zoho.eu     # 465 + SMTP_SECURE=true (implicit TLS); or 587 + SMTP_SECURE=false (STARTTLS)
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=<the mailbox>
SMTP_PASS=<password, or an app password when two-factor authentication is on>
```

Prove the credentials from your machine before deploying: `npm run mail-test` sends one test email to `REPORT_TO` (or `npm run mail-test -- --to you@example.com`) through the configured transport. The From address is `SMTP_USER`; Zoho Mail rejects any other From unless it is an alias of that mailbox. In Development use a mailbox you control; in production a mailbox the organisation owns, whose credential its owner provides.

**`catalyst`** — Catalyst Mail (`app.email().sendMail`). Needs Console → **Mail → Senders**: a verified individual sender or a verified domain (DNS TXT). Set `MAIL_TRANSPORT=catalyst` and `REPORT_FROM=<verified sender>`.

## 5. Environment variables and deploy

Environment variables travel **inside** `functions/autoscan-run/catalyst-config.json`, and `catalyst deploy` replaces the function's variables with that file's contents every time — anything set in the Console is wiped. So the file is generated from `.env` and never committed:

```bash
npm run catalyst-config          # writes functions/autoscan-run/catalyst-config.json from .env (prints names only)
npm run deploy                   # = catalyst-config + catalyst deploy --only functions
npm run deploy -- --check        # regenerate and show the command, deploy nothing
```

**One `.env` for both environments.** The same variable set is deployed everywhere. The function asks Catalyst which environment it is running in — the first log line of every run, `job.profile`, prints it — and picks its profile:

| Catalyst environment | Profile | Variables used |
|---|---|---|
| Development | `sandbox` | The plain ones — `BOOKS_ORG_ID` is the sandbox organisation |
| Production | `production` | `PROD_<NAME>` when set, otherwise `<NAME>` |

Six variables are never inherited by the production profile — `BOOKS_ORG_ID`, `BOOKS_APP_BASE`, `DRY_RUN`, `SCAN_SINCE`, `CARRIAGE_ITEM_ID`, `CARRIAGE_ACCOUNT_ID`. Without their `PROD_` value the production function either refuses to start (`PROD_BOOKS_ORG_ID`, `PROD_SCAN_SINCE`) or stays safe (`PROD_DRY_RUN` empty means dry-run). It also refuses to start if `PROD_BOOKS_ORG_ID` equals the sandbox organisation.

## 6. Job pool and first run

Job functions run through **Job Scheduling**; there is no Execute button on the function.

1. Console → **Job Scheduling → Job Pools → Create**: name `autoscan-pool`, type *Function*, memory 512 MB, capacity 1.
2. **Job Scheduling → Jobs → Submit Job**: pool `autoscan-pool`, function `autoscan-run`, params `{}`.
3. **Logs** (DevOps → Logs, component Functions → `autoscan-run`, last hour). Job logs arrive with a delay of one to three minutes. Expect `job.profile`, `run.scan`, `run.done`, `job.finished`, and — with `MAIL_TRANSPORT=log` — the text report.
4. `run_log` has a row with status DONE; `document_state` has one row per inbox document, none left in `PROCESSING`.

## 7. Cron

**Job Scheduling → Crons → Create**: name `autoscan-every-30m`, *Periodic*, every 30 minutes, target pool `autoscan-pool` → function `autoscan-run`, enable. Restrict it to business hours if the Console allows; otherwise leave it running around the clock — an empty run makes a few queries and no AI call.

## 7b. Daily report

No extra cron is needed. The first run after `DAILY_REPORT_HOUR` (default 17, in `REPORT_TIMEZONE`) sends the end-of-day digest through `MAIL_TRANSPORT` and writes a `daily_YYYY-MM-DD` marker row in `run_log`, so it goes out once per day. Make sure the cron still fires after that hour.

To send it on demand: the Console's Submit Job has no params field, so the practical way is to set `DAILY_REPORT_HOUR=0`, deploy, submit a job, set it back and deploy again (the marker stops a second send that day). Job params `{"mode":"daily_report","force":"true"}` work when a job is submitted through the Catalyst API or CLI. With `MAIL_TRANSPORT=log` the text version lands in the function log; the HTML can be previewed locally with `npm run run -- --daily-report`, which writes it to `out/` from the local state file.

## 8. Promote to Production

Nothing in `.env` is "switched": production has its own `PROD_` values next to the sandbox ones (§5).

1. **Books, production organisation.** Create the vendor custom fields *Carriage Rule* (Zero / Fixed / Ignore) and *Carriage Tolerance*, and the item custom field *Supplier Reference*, with the same labels as in the sandbox. Finance sets the rule per supplier.
2. **`.env`.**
   - `PROD_BOOKS_ORG_ID` — the production organisation.
   - `PROD_SCAN_SINCE` — the go-live moment in UTC, for example `2025-01-31T09:00:00Z`. Only documents that arrive after it are read; everything older is left alone.
   - `PROD_DRY_RUN=true`.
   - `PROD_PO_PREFIX` / `PROD_PO_PAD_WIDTH` — if production numbers its purchase orders differently from the sandbox.
   - `PROD_CARRIAGE_ITEM_ID` or `PROD_CARRIAGE_ACCOUNT_ID` — used only for invoiced carriage on a PO that has no carriage line. If production keeps one carriage item per supplier, use the freight purchase account they share; `npm run probe -- items carriage --org <production organization_id>` lists the items with their account id.
   - `PROD_REPORT_TO` — the finance inbox.

   Then `npm run deploy`. Development receives the new variables and nothing changes there.
3. **Catalyst Console → Settings → Environments → deploy to Production** (functions, Data Store tables, Job Scheduling). Check in Production that both tables exist and are empty, that the job pool and the cron exist and are enabled, and that the function's environment variables include the `PROD_` ones. If the promotion did not carry the variables over, set them in the Console for Production.
4. **First production run.** The log must show `job.profile` with `profile: "production"`, the production organisation and `dry_run: true`, and `run.scan` with `skipped_old` equal to the number of older documents in the inbox. If it says `profile: "sandbox"`, stop the cron: Catalyst did not report the environment and the production profile is not active.
5. **After sign-off.** Set `PROD_DRY_RUN=false`, deploy, promote to Production again, and switch off any earlier automation that bills from the same inbox. Check the first production bill by hand: total, date, due date, PO link, attachment.

## Rolling back

- **A bad deploy:** check out the previous commit, `npm run deploy`, promote again. The Data Store needs no rollback: an older version simply does not write columns that were added later.
- **Stop all writes immediately:** disable the cron in Job Scheduling. To keep reporting while stopping writes, set `PROD_DRY_RUN=true` and deploy.
- **A bill created wrongly:** correct or delete it in Books. The document's row stays `BILLED`; if the document must be processed again, upload it again once the cause is fixed — the same supplier invoice number will be treated as a duplicate for as long as the original bill exists.
