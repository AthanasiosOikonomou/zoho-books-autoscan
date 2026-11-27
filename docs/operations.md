# Operations

How to tell that AutoScan is healthy, what each outcome means, and what to do when something is wrong. Setup and deployment are in [`catalyst-setup.md`](catalyst-setup.md); the variables named here are described in [`configuration.md`](configuration.md).

## A healthy run

Logs are in the Catalyst Console under DevOps → Logs → Functions → `autoscan-run`, and arrive a few minutes after the run. Every line is one JSON object carrying the run id, so a run can be followed by filtering on it.

| Log event | Meaning | Check |
|---|---|---|
| `job.profile` | First line of every run. | `profile` is `sandbox` in Development and `production` in Production; `books_org` is the expected organisation; `dry_run` is what you intend. |
| `run.scan` | The inbox was listed and compared with the state table. | `new` and `retry` are the work for this run; `skipped_old` counts documents older than `SCAN_SINCE`. |
| `run.done` | The run finished. | `billed`, `exceptions`, `duplicates`, `claude_calls`, `est_cost_usd`; `stopped` is empty unless a cap was hit. |
| `daily.sent` | The day's digest went out. | Once per day, after `DAILY_REPORT_HOUR`. |
| `job.finished` | Last line. | `status` is `DONE`. |

In the Data Store, `run_log` has one row per run with status `DONE`, and `document_state` has no rows left in `PROCESSING` once a run has ended.

A run with nothing to do logs `run.scan` with `new: 0, retry: 0` and ends in a couple of seconds without calling Claude.

## Statuses and reason codes

A document's **status** says where it stands; an exception also carries a **reason code**. Finance sees the reason, the detail and the action in the daily digest.

### Statuses

| Status | Meaning | Open? |
|---|---|---|
| `BILLED` | Bill created from the PO, document attached, inbox file deleted. | Closed |
| `CREDITED` | Vendor credit created from a credit note. | Closed |
| `DUPLICATE` | The supplier invoice (or credit note) number already exists for this vendor. Nothing was written; the file stays in the inbox. | Closed |
| `WOULD_BILL` / `WOULD_CREDIT` | Matched, but the run was a dry run. The first live run acts on it. | Open |
| `BILLED_NO_ATTACH` | The bill exists but the attachment was not confirmed. The next run attaches only. | Open |
| `EXCEPTION` | Could not be processed; see the reason code. | Open |
| `PROCESSING` | Claimed by a run that is still going — or that died. Retried once the claim is older than `LOCK_STALE_MINUTES`. | Open |

### Reason codes

Every open document is re-evaluated every `RETRY_AFTER_HOURS` (6) up to `MAX_ATTEMPTS` (28) using the stored reading, so the "fix" column is all that is needed — nobody has to re-trigger anything. Service errors are retried on the next run. After a deploy, every open document is re-checked once on the next run (`RECHECK_HELD_BEFORE`), so a code or rule change does not wait for the 6-hour window.

| Reason | Meaning | Fix |
|---|---|---|
| `NO_PO_REF` | No purchase order reference could be read from the document. | Check the document. Bill by hand, or ask the supplier to quote the PO. |
| `PO_NOT_FOUND` | The reference printed on the document matches no PO number or PO reference in Books. | Create or correct the PO in Books. |
| `LOW_CONFIDENCE` | The reading was below `CONFIDENCE_THRESHOLD`. | Review the values shown in the report; bill by hand if they are wrong. |
| `TOTAL_MISMATCH` | The invoice total differs from the PO total (or its remaining value, or the matched lines plus carriage) by more than `TOTAL_TOLERANCE`. | Amend the PO, or query the invoice with the supplier. |
| `BILL_TEMPLATE_MISMATCH` | What Books would bill from the PO's remaining quantities is not the invoice amount, or a matched PO line is no longer billable. | Check earlier bills on the PO; bill by hand if needed. |
| `LINE_UNMATCHED` | An invoice line matches no PO line by supplier code, and no single PO line fits it by value. | Add the supplier's code to the item (*Supplier Reference* or MPN), or check the PO lines. |
| `QTY_EXCEEDS` | More was invoiced than is still un-billed on the PO line. | Check the PO and its earlier bills. |
| `PRICE_MISMATCH` | A unit price — including any product surcharge — is above the PO price, or below it by more than the tolerance. | Amend the PO price, or query the supplier. |
| `CARRIAGE_MISMATCH` | Carriage is higher than what is open on the PO, beyond the vendor's carriage rule. | Amend the PO, or set *Carriage Rule* / *Carriage Tolerance* on the vendor. |
| `CREDIT_NOTE` | A credit note whose total or lines could not be read. | Raise the vendor credit by hand. |
| `CREDIT_TOTAL_MISMATCH` | Books priced the credited lines differently from the printed total; the draft credit was removed. | Check the PO lines and tax; raise the vendor credit by hand if needed. |
| `NOT_AN_INVOICE` | A statement, delivery note, quotation or similar. | Handle by hand and remove it from the inbox. |
| `UNSUPPORTED_FILE` | Not a PDF, JPG or PNG. | Convert it or bill by hand. |
| `PAGE_LIMIT` | More pages than `CLAUDE_PAGE_CAP`. | Bill by hand. |
| `AI_ERROR` | The reading failed (service error, timeout, or a truncated answer). | Retried automatically. If it persists for one document, see *Troubleshooting*. |
| `BOOKS_ERROR` | A Books call failed after retries. | Retried automatically. |
| `ATTACH_FAILED` | The bill exists but the document could not be attached. | Retried automatically as attach-only. |

Two notes appear on successful outcomes rather than as exceptions: `NO_MPN` means the PO's lines carry no supplier code and the document was matched on totals instead; and a bill may carry a remark such as "billed below the PO price" or "matched by value — add this code to the item".

The reason codes and the instruction text shown to finance are defined in `functions/autoscan-run/src/pipeline/reasons.js`.

## How finance resolves an exception

1. Read the reason and the detail in the daily digest; follow the link to the PO.
2. Fix the cause **in Books**: the PO, the item's supplier code, or the vendor's carriage rule.
3. Do nothing else. Within `RETRY_AFTER_HOURS` (on the first run inside the cron's hours) the document is re-checked against the corrected data and billed. No AI call is made for this.

If the document should not be billed at all, bill or file it by hand and remove it from the inbox; it then drops out of the report.

## Troubleshooting

### The run exits immediately with `run.skipped_active_run`

**Cause.** A `run_log` row is still `RUNNING` from a run younger than `LOCK_STALE_MINUTES`, either because a run is in progress or because one died.
**Fix.** Wait for the window to pass, or set that row's status to `FAILED` in the Data Store.
**Verify.** The next run logs `run.scan`.

### Documents stay in `PROCESSING`

**Cause.** The run that claimed them ended abnormally.
**Fix.** Nothing; a claim older than `LOCK_STALE_MINUTES` is retried. De-duplication prevents a second bill if the first one was created before the run died.
**Verify.** The rows move to a final status after the next run.

### `AI_ERROR` with "output truncated"

**Cause.** A very long invoice exceeded `CLAUDE_MAX_OUTPUT_TOKENS`.
**Fix.** Raise the value and deploy. Only produced tokens are billed, so a higher cap has no cost of its own.
**Verify.** The document is read on the next run.

### Many `AI_ERROR` in one run

**Cause.** An invalid or exhausted API key, a model id that does not exist for the key, or an outage.
**Fix.** Run `npm run claude-check` locally with the same key and model. Check the spend limit of the Anthropic workspace.
**Verify.** `npm run claude-check` prints the models and a successful minimal call.

### `run.stopped_daily_limit`

**Cause.** The organisation's daily Books API allowance is used up.
**Fix.** None needed; the run stopped cleanly and the remaining documents are untouched. If it recurs, lower `MAX_NEW_PER_RUN` or review what else is using the allowance.
**Verify.** The next day's first run processes the remainder.

### The daily digest did not arrive

Work through these in order:

1. `MAIL_TRANSPORT` is `log` → the report is in the function log, by design.
2. No run happened after `DAILY_REPORT_HOUR` in `REPORT_TIMEZONE` → extend the cron's hours.
3. A `daily_YYYY-MM-DD` row already exists in `run_log` → it was sent; check spam and `REPORT_TO`.
4. `report.send_failed` or `daily.failed` in the log → the transport rejected it. Run `npm run mail-test` with the same `.env`; for SMTP check the password, and that the From address is the mailbox itself.

To send it again on demand, see [`catalyst-setup.md` §7b](catalyst-setup.md#7b-daily-report).

### Production logs `profile: "sandbox"`

**Cause.** Catalyst did not report the environment to the function, so the production profile is not active.
**Fix.** Disable the cron in Production immediately and investigate before any further run. Do not work around it with variables.
**Verify.** `job.profile` shows `profile: "production"` and the production organisation.

### The function refuses to start: "Missing required configuration"

**Cause.** A required variable is absent — in Production typically `PROD_BOOKS_ORG_ID` or `PROD_SCAN_SINCE`, or the promotion did not carry the variables over.
**Fix.** Add the value to `.env`, `npm run deploy`, promote again; or set it in the Console for Production if the promotion dropped it.
**Verify.** `job.profile` is logged.

### `bill.total_differs` in the log, or a bill with a "differs from invoice" note

**Cause.** Books computed a different total from the one on the invoice — usually tax recalculated on a line, or the adjustment not applied.
**Fix.** The bill exists and is flagged in the digest. Correct it in Books; check the tax on the PO lines so the next one is right.
**Verify.** The bill total equals the invoice total.

### `store.rowid_mismatch` in the log

**Cause.** After an insert, the row id read back through ZCQL is not numerically equal to the one in the insert response. Row ids exceed JavaScript's safe integer range, so the response value is rounded; the warning records a case where even the rounded comparison disagrees.
**Fix.** The store already uses the id read back through ZCQL, so no action is needed for the row itself. If state rows stop updating (a document is treated as new on every run), make sure no code path takes a ROWID from an insert or update response — see [`decisions.md`](decisions.md), D-43.
**Verify.** The document's row shows the latest status and attempt count after the next run.

### After a prompt change, many documents are read again

**Cause.** By design. A new prompt version re-reads, once, every document parked for a reading or matching reason.
**Fix.** None. The cost is one call per parked document, capped per run by `MAX_RETRY_PER_RUN`.
**Verify.** `extraction.stale_prompt` log lines for the affected documents, once each.

## Changing the prompt

The prompt is `functions/autoscan-run/src/claude/prompt.v7.md`. Any change, however small, alters the prompt version.

1. Edit the prompt. Keep every example synthetic — never paste a real document into it.
2. `npm run golden -- --force` re-reads the local reference documents with the new prompt; compare `summary.md` with the previous one.
3. `npm test`.
4. Deploy. Expect the one-time re-read described above.

## Testing a new batch of real documents

Real documents must never be committed. Everything below lives in the git-ignored `golden/` folder.

1. Put the documents in a subfolder, for example `golden/batch-2/`.
2. **Read them** with the extractor only — no Books, no state:
   ```bash
   npm run golden -- --dir golden/batch-2
   ```
   Results are cached by file hash and prompt version under `golden/batch-2/_results/`; `summary.md` has one row per document.
3. **Pull the purchase orders behind them**, read-only, from the organisation that holds them:
   ```bash
   npm run replicate -- pull --org <organization_id> --dir golden/batch-2
   ```
   Only GET requests are made. Addresses, contact persons and bank details are not copied.
4. **Check offline** what each document would do with today's code:
   ```bash
   npm run replicate -- check --dir golden/batch-2
   ```
5. **Rebuild them in the sandbox** — vendors, items and purchase orders with the same numbers, lines and prices:
   ```bash
   npm run replicate -- push --dir golden/batch-2 --plan     # shows what would be created
   npm run replicate -- push --dir golden/batch-2
   ```
6. Upload the documents to the sandbox Documents inbox, let the job run (or `npm run run`), then:
   ```bash
   npm run replicate -- verify --dir golden/batch-2          # bill total, date, due date, PO link, attachment per document
   ```

## Routine checks

| When | Check |
|---|---|
| Daily | The digest arrived; nothing has been waiting longer than expected. |
| Weekly | `run_log`: no `FAILED` runs; `est_cost_usd` in the usual range. |
| After every deploy | `job.profile` shows the intended profile, organisation and dry-run flag. |
| When a supplier changes its invoice layout | Add a sample to the reference documents and run the golden set. |
| When the Claude model is retired or replaced | Set `CLAUDE_MODEL`, run `npm run claude-check` and the golden set, and update the price table in `src/claude/extractor.js`. |
