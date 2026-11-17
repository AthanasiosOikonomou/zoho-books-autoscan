# Configuration

Every behaviour that can be tuned is an environment variable, read in one place: `functions/autoscan-run/src/config.js`. Locally the values come from `.env` (copy `.env.example`); on Catalyst they are the function's environment variables, generated from `.env` at deploy time by `npm run catalyst-config`.

**Reading this page**

- *Default* is what the code uses when the variable is empty.
- **Secret** marks values that must never be committed, logged or pasted into a ticket.
- **Never inherited** marks the six variables the production profile does not take from the sandbox set; it needs its own `PROD_` value (see [Production overrides](#production-overrides)).
- A variable reaches the deployed function only if it is listed in `DEPLOY_VARS` in `scripts/catalyst-config.js`. Variables marked *local* are used by scripts on your machine only.

## Zoho Books

| Variable | Default | Purpose |
|---|---|---|
| `BOOKS_DC` | `eu` | Zoho data centre suffix (`eu`, `com`, `in`, `com.au`, …). Selects the API and accounts hosts. |
| `BOOKS_ORG_ID` | — required | The Books `organization_id` the run reads and writes. Locally and in Development this must be the **sandbox**. **Never inherited.** A wrong value writes bills into the wrong organisation. |
| `BOOKS_CLIENT_ID` | — required | Self Client id from the Zoho API console. |
| `BOOKS_CLIENT_SECRET` | — required | **Secret.** Self Client secret. |
| `BOOKS_REFRESH_TOKEN` | — required | **Secret.** Long-lived token produced by `npm run token -- <grant-code>`. Whoever holds it can act in Books with the authorising user's role; rotate by revoking the Self Client's token and generating a new one. |
| `BOOKS_RATE_PER_MIN` | `80` | Token-bucket limit for all Books calls. The organisation cap is 100 per minute. |
| `BOOKS_MAX_RETRIES` | `3` | Retries on 429, 5xx and network errors, with backoff. |
| `BOOKS_INBOX_PAGE_SIZE` | `200` | Page size when listing the Documents inbox. |
| `BOOKS_APP_BASE` | derived from `BOOKS_DC` and `BOOKS_ORG_ID` | Base URL for the links in reports. **Never inherited.** |
| `SEED_ALLOW_ORG_ID` | — *local* | Scripts that write to Books refuse to run unless this equals `BOOKS_ORG_ID`. Set it to the sandbox id and nothing else. |

## Claude

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — required | **Secret.** API key of the Anthropic workspace that pays for the reading. Set a spend limit on that workspace. |
| `CLAUDE_MODEL` | `claude-haiku-5-5` | Model id used for every document. Verify it exists for the key with `npm run claude-check`. |
| `CLAUDE_FALLBACK_MODEL` | empty (disabled) | A stronger model to try when the first reading is not confident. |
| `CLAUDE_FALLBACK_BELOW_CONFIDENCE` | `0` (never) | Confidence below which the fallback model is called. Each fallback is a second paid call. |
| `CLAUDE_PAGE_CAP` | `6` | Documents with more pages are not read (`PAGE_LIMIT`). |
| `CLAUDE_MAX_OUTPUT_TOKENS` | `6000` | Output cap. A long invoice needs roughly 1,500; a response cut off at the cap is an error, not a reading. |
| `CLAUDE_TIMEOUT_MS` | `60000` | Request timeout. |
| `CLAUDE_MAX_RETRIES` | `2` | SDK-level retries on overload and rate limiting. |
| `CLAUDE_PROMPT_CACHE` | `true` | Marks the system prompt as cacheable so later documents in a run pay the cached-input price. |

## Matching

| Variable | Default | Purpose |
|---|---|---|
| `TOTAL_TOLERANCE` | `1.00` | Largest accepted difference between the invoice total and the expected total, in the organisation's currency. |
| `BILL_ADJUST_TO_INVOICE` | `true` | Post the difference inside the tolerance as the bill's adjustment, so the bill total equals the invoice total. |
| `CONFIDENCE_THRESHOLD` | `0.75` | Readings below this confidence go to review (`LOW_CONFIDENCE`). |
| `PO_PREFIX` | `PO-` | Prefix of purchase order numbers in Books. |
| `PO_PAD_WIDTH` | `5` | Zero-padded width of the number part (`PO-00235`). |
| `PO_EXAMPLE` | prefix + `235` padded | The PO shape shown to the model as "what a genuine reference looks like". Changing it changes the prompt version. |
| `PO_LEGACY_PREFIXES` | `IPO/,IPO ,IPO-` | Comma-separated prefixes of older reference formats suppliers still quote. Set this to your own legacy formats; left empty, the default list applies. |
| `MATCH_AGAINST_REMAINING` | `true` | In total matching, also accept the PO's remaining un-billed value. |
| `PHASE2_ENABLED` | `false` | Turn on line-level matching. |
| `LINE_PRICE_TOLERANCE_PCT` | `5` | Per line: how far **below** the PO unit price the invoice may be and still bill at the invoice price. |
| `LINE_PRICE_TOLERANCE_UP_PCT` | `0` | Per line: how far **above** the PO unit price is accepted. `0` sends every increase to review. |
| `LINE_PRICE_TOLERANCE_ABS` | `0.01` | Rounding guard in both directions. |
| `SUPPLIER_REF_LABEL` | `Supplier Reference` | Label of the item custom field holding the supplier's code. |
| `CARRIAGE_RULE_LABEL` | `Carriage Rule` | Label of the vendor custom field holding Zero / Fixed / Ignore. |
| `CARRIAGE_TOLERANCE_LABEL` | `Carriage Tolerance` | Label of the vendor custom field holding the amount used by Fixed. |
| `DEFAULT_CARRIAGE_RULE` | `Zero` | Rule for a vendor with nothing set. |
| `CARRIAGE_ITEM_ID` | empty | Item used for invoiced carriage when the PO has no carriage line and the organisation has one carriage item for all suppliers. **Never inherited.** |
| `CARRIAGE_ACCOUNT_ID` | empty | Freight purchase account used instead when carriage items are kept per supplier. **Never inherited.** With both empty, the first product line's account is used. |
| `CARRIAGE_BELOW_PO_OK` | `true` | Carriage at or below the PO passes under every vendor rule. `false` applies the vendor rule in both directions. |
| `SURCHARGE_IN_PRICE` | `true` | Treat product surcharges as part of the product price. `false` counts them as carriage. |
| `LINE_VALUE_FALLBACK` | `true` | Allow an item without a supplier code to be matched by value when exactly one PO line fits. `false` matches by code only. |

> [!NOTE]
> `CARRIAGE_BELOW_PO_OK`, `SURCHARGE_IN_PRICE` and `LINE_VALUE_FALLBACK` are read by `src/config.js` but are not yet listed in `DEPLOY_VARS`. Until they are added there, the deployed function always uses their defaults; a value in `.env` affects local runs only.

## Run behaviour

| Variable | Default | Purpose |
|---|---|---|
| `DRY_RUN` | `true` | When true the pipeline runs in full and reports what it would do, but writes nothing to Books. Only the literal `false` enables writes. **Never inherited.** |
| `SCAN_SINCE` | empty (all documents) | ISO date or date-time in UTC. Inbox documents created before it are never read, recorded or reported. Required in production. **Never inherited.** |
| `MAX_NEW_PER_RUN` | `40` | Cap on new documents per run. |
| `MAX_RETRY_PER_RUN` | `20` | Cap on retried documents per run. |
| `CONCURRENCY` | `3` | Documents processed in parallel. |
| `RETRY_AFTER_HOURS` | `6` | How often an open document is re-evaluated. No AI call is made on these retries. |
| `MAX_ATTEMPTS` | `28` | Attempts before a document is left for manual handling. With the default interval this is one week. |
| `RETRY_TRANSIENT_AFTER_MINUTES` | `0` | Delay before retrying service errors. `0` retries on the next run. |
| `TIME_BUDGET_RATIO` | `0.7` | Share of the function's maximum execution time after which no further documents are started. |
| `LOCK_STALE_MINUTES` | `15` | Age after which a `RUNNING` run or a `PROCESSING` claim is considered dead. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

## Report

| Variable | Default | Purpose |
|---|---|---|
| `MAIL_TRANSPORT` | `log` | `log` writes the report to the function log; `smtp` sends through a mailbox; `catalyst` uses Catalyst Mail. |
| `REPORT_TO` | empty | Comma-separated recipients of the digest. Required for `smtp` and `catalyst`. |
| `REPORT_DEV_COPY` | empty | Comma-separated addresses copied on every report. |
| `REPORT_FROM` | `SMTP_USER` | Sender address. Leave empty for SMTP; for Catalyst Mail it must be a verified sender. |
| `REPORT_SUBJECT_PREFIX` | `AutoScan` | Subject prefix, useful to tell environments apart. |
| `DAILY_REPORT_HOUR` | `17` | Local hour after which the first run sends the day's digest. `off` disables it. |
| `REPORT_TIMEZONE` | `Europe/London` | Time zone for "today" and for `DAILY_REPORT_HOUR`. |
| `REPORT_PER_RUN` | `false` | Also email the per-run report. By default it goes to the log only. |
| `SMTP_HOST` | `smtp.zoho.eu` | SMTP server. |
| `SMTP_PORT` | `465` | `465` with `SMTP_SECURE=true` (implicit TLS) or `587` with `SMTP_SECURE=false` (STARTTLS). |
| `SMTP_SECURE` | `true` | See `SMTP_PORT`. |
| `SMTP_USER` | — required for `smtp` | The mailbox the digest is sent from. |
| `SMTP_PASS` | — required for `smtp` | **Secret.** The mailbox password, or an app-specific password when two-factor authentication is on. |

## Production overrides

One `.env` serves both Catalyst environments. In the Production environment the function uses `PROD_<NAME>` when it is set and `<NAME>` otherwise, so any variable above can be overridden for production by prefixing it. The usual set:

| Variable | Purpose |
|---|---|
| `PROD_BOOKS_ORG_ID` | The production organisation. **Required**; the function refuses to start without it, or if it equals `BOOKS_ORG_ID`. |
| `PROD_SCAN_SINCE` | The go-live moment in UTC. **Required**; nothing created before it is ever read. |
| `PROD_DRY_RUN` | Empty or `true` keeps production in dry-run. `false` makes it create bills. |
| `PROD_CARRIAGE_ITEM_ID` / `PROD_CARRIAGE_ACCOUNT_ID` | Production ids for invoiced carriage on a PO without a carriage line. |
| `PROD_PO_PREFIX` / `PROD_PO_PAD_WIDTH` | Production PO numbering, when it differs from the sandbox. |
| `PROD_REPORT_TO` | Production digest recipients. |
| `PROD_REPORT_SUBJECT_PREFIX` | For example `AutoScan` in production and `AutoScan (sandbox)` in Development. |

Local scripts (`npm run seed`, `probe`, `golden`, `run`, `replicate`) always use the plain variables. Looking at another organisation takes an explicit `--org <organization_id>` and is read-only.

## Local only

| Variable | Default | Purpose |
|---|---|---|
| `CATALYST_DC` | — | Data centre passed to the Catalyst CLI by `npm run deploy`. |
| `CATALYST_TOKEN` | — | **Secret.** Token from `catalyst token:generate`; makes this repository deploy as that user regardless of the CLI's global login. |
| `STATE_FILE` | `./.autoscan-state.json` | Where local runs keep their state. Git-ignored. |
| `OUT_DIR` | `./out` | Where local runs write reports. Git-ignored. |

## Changing a value on Catalyst

`catalyst deploy` replaces the function's variables with the contents of `catalyst-config.json`. To change a value: edit `.env`, run `npm run deploy`, and — for production — promote to Production again. A value typed into the Console is lost on the next deploy.
