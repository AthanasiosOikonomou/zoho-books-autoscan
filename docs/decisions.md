# Decisions

The design decisions that shaped AutoScan, each with the reason it was taken and what it replaced or ruled out. Entries are numbered and never rewritten: a decision that no longer holds is marked as superseded and points to its replacement.

The business rules themselves are in [`requirements.md`](requirements.md); this log explains engineering choices.

## Platform

| # | Decision | Why |
|---|---|---|
| D-01 | Rebuild as a Node.js Job function on Zoho Catalyst instead of repairing the Deluge scheduled function. | The Deluge version was bound by runtime caps, read a single page of the inbox and kept no state. A Job function has a 15-minute window, environment variables and a data store, and still runs inside the organisation's Zoho account. |
| D-02 | Build and test against a Books sandbox organisation and the Catalyst Development environment; the old schedule is switched off only when the new one is accepted. | Agreed way of working: nothing is tried on live accounting data, and the new automation only takes over once it has been accepted. |
| D-03 | Token scope `ZohoBooks.fullaccess.all`; protection through the Books user role rather than the scope. | The Documents endpoints have no granular scope, so a narrow scope cannot reach the inbox. |
| D-04 | One variable set for both Catalyst environments. The profile (sandbox or production) comes from the environment Catalyst reports at run time. Production reads `PROD_<NAME>` overrides, never inherits the organisation id, app base URL, dry-run flag, go-live cutoff or carriage ids, and refuses to start without its own or against the sandbox organisation. | Production is promoted from the Console, and how variables travel with that promotion is not documented — identical variables everywhere removes the question. The tolerances under test are guaranteed to be the ones that go live, and a copied `DRY_RUN=false` can never reach production. |
| D-05 | Deploy with a per-repository Catalyst token (`CATALYST_TOKEN`) when one is set. | The CLI holds a single global login; a developer working on several projects would otherwise deploy as the wrong user. |
| D-06 | `catalyst-config.json` is generated from `.env` before every deploy and is git-ignored; `catalyst.json` is committed. | Deploy replaces the function's variables with the file's contents, so the file must carry real values and therefore must never be committed. Committing `catalyst.json` means `catalyst init` only writes the local project link. |
| D-07 | The report is sent by SMTP from a mailbox the organisation owns; Catalyst Mail and a log-only transport remain selectable. | Catalyst Mail needs a verified sender or domain. SMTP works with an existing mailbox and keeps the credential with its owner. The log transport allows the pipeline to be proven before any mailbox exists. |

## Reading documents

| # | Decision | Why |
|---|---|---|
| D-08 | Use the cheapest capable Claude model; a stronger one only as an explicit configuration switch, off by default. | Cost per document is a fraction of a cent and a reference set of real documents is read correctly. The reference set, not preference, decides whether a stronger model is ever needed. |
| D-09 | Force the output through a tool schema (`tool_choice`) and cache the system prompt. | No free text to parse, no retries for malformed JSON, and every document after the first in a run pays a fraction of the input price. |
| D-10 | The extraction is stored with the document's state and reused for every retry; an identical file (same hash) reuses the earlier extraction. | Reading is the only paid, non-deterministic step. Reconciliation over a week must not multiply its cost. |
| D-11 | The Books PO number format is configuration (`PO_PREFIX`, `PO_PAD_WIDTH`, `PO_EXAMPLE`) and is rendered into the prompt. | The model must know what a genuine PO reference looks like for this organisation; hard-coding it would tie the prompt to one numbering scheme. |
| D-12 | The prompt version is a hash of the rendered prompt, stored with each extraction. After a prompt change, documents parked for a reading reason are read again, once. | A better prompt should rescue documents the old one misread, without re-reading everything. |
| D-13 | That re-read also covers documents parked for a matching reason (`LINE_UNMATCHED`, `CARRIAGE_MISMATCH`, `PRICE_MISMATCH`, `QTY_EXCEEDS`, `TOTAL_MISMATCH`). | A misread line, quantity, price or charge surfaces as exactly these reasons; otherwise a parked document keeps its old reading for the whole reconciliation window. Cost: one AI call per parked document per prompt change, capped by `MAX_RETRY_PER_RUN`. |
| D-14 | The model copies, the code computes. Delivery-type charges are returned one by one and summed in code; the invoice date is also returned exactly as printed and converted in code, day first. The model's own totals and ISO date are only the fallback. | On real documents the model added two charges incorrectly and wrote a day-first date month-first — in both cases with a note admitting uncertainty. Arithmetic and date conversion are now deterministic. |
| D-15 | A response cut off at the output-token cap is an error, and the cap is set well above what a long invoice needs. | A truncated tool call parses into an empty extraction with zero lines and zero confidence, which looked like "nothing found". Only tokens actually produced are billed, so a high cap costs nothing. |
| D-16 | A surcharge printed as a coded row of the product table is a charge, not a product line; a value in the customer's PO format under a bare "Order No" label is the PO reference. | Both come from real layouts. A surcharge row read as a product could never match a PO line. |
| D-17 | Documents over the page cap are not read. | They are statements or catalogues; reading them costs money and cannot produce a bill. |

## Matching

| # | Decision | Why |
|---|---|---|
| D-18 | Duplicates are detected on vendor + supplier invoice number, never on "the PO already has a bill". | One PO is billed by several supplier invoices when deliveries are partial. |
| D-19 | A second in-run claim on vendor + invoice number, taken synchronously before the first await. | Two copies of the same invoice in one batch are processed in parallel; without the claim both would pass the Books check before either bill existed. |
| D-20 | Total matching also compares the invoice with the PO's remaining value. | The closing invoice of a PO that was partly billed by hand then matches automatically. |
| D-21 | Total tolerance of 1.00 on the invoice total. Supersedes an initial tolerance of 0.02. | Business rule; pence-level differences between PO and invoice are routine. |
| D-22 | Line matching keys, in order: the item custom field *Supplier Reference* on the PO line, the item MPN, SKU, item code — compared with case, spaces, dots, dashes, slashes and underscores removed. | Purchase orders print the supplier's reference; suppliers print the same code with different punctuation. |
| D-23 | The item MPN is read from `part_number`; a non-scalar `item_code` is ignored. | `part_number` is the API name of the Books MPN field — `item.mpn` does not exist, so an earlier MPN fallback never matched. Some organisations return `item_code` as an empty object. |
| D-24 | Custom fields (vendor carriage rule and tolerance, item supplier reference) are found by label, not by API name. | The same field is `cf__sb_<org>_…` in a sandbox and `cf_…` in production. |
| D-25 | Line-matched bills carry the invoice: invoiced quantities, invoice unit prices, invoice carriage. A PO with no coded lines falls back to the total match. | The bill must equal the supplier's document; partial deliveries are routine; item data is completed over time. |
| D-26 | Price policy: up to 5 % below the PO unit price is billed at the invoice price and noted; any increase, or a larger decrease, is `PRICE_MISMATCH`. A one-penny guard absorbs rounding. Supersedes an interim symmetric tolerance with an "accept lower price" flag. | Business rule. Kept as two separate limits (`LINE_PRICE_TOLERANCE_PCT`, `LINE_PRICE_TOLERANCE_UP_PCT`) so a change of policy is a configuration change, not a release. |
| D-27 | Pack against each: same code, the invoice line total is a whole number of PO units to the penny, quantities differ by a whole factor of at least 2 and the PO still has those units → billed in PO units and noted. | Suppliers invoice single units where the PO line is a pack. Anything that does not fit exactly keeps the plain reading and fails as a quantity or price mismatch. |
| D-28 | The unit price comes from the line total when the printed price does not multiply up to it; rows printed at 0.00 are noted and skipped. | Prices quoted per litre, per hundred or before a line discount; courier names printed as zero-value rows. |
| D-29 | Carriage at or below the PO is accepted under every vendor rule and billed on the PO's carriage line for its whole open quantity; none invoiced leaves the line open for a later carriage-only invoice; the vendor rule decides only carriage above the PO (`CARRIAGE_BELOW_PO_OK`). Supersedes a two-way check. | Business rule. PO carriage is compared on what is still open, so a second part-shipment charging carriage again counts as above the PO. |
| D-30 | A product surcharge is part of the product price, spread over the product lines by value before the price check (`SURCHARGE_IN_PRICE`). It is classified in code from the printed description: "surcharge" or "levy" without a delivery word. | Business rule: surcharges are meant to be inside the PO's item prices. Classifying in code leaves the prompt — and every stored extraction — untouched when the rule changes. |
| D-31 | Value fallback for items without a supplier code: exactly one open PO line without *Supplier Reference* or MPN, same unit price (or the same money as a whole pack), enough open quantity, not claimable by another invoice line, descriptions share a word → matched and noted with the code to add (`LINE_VALUE_FALLBACK`). | A fallback was requested for items whose code is not yet in Books. A description alone is never a key for money; a unique value is. A PO line that has a supplier code is matched by it or not at all. |
| D-32 | No special carriage handling per purchase order. | All POs are treated the same whatever raised them; the vendor-level rule is the only rule, which keeps the behaviour explainable. |

## Billing

| # | Decision | Why |
|---|---|---|
| D-33 | Bills are built from the Books bill template of the PO and sent back as a whitelisted payload. | The template carries the correct vendor, accounts, taxes and line links, so none of that is reconstructed by hand; only the fields a bill needs are sent back. |
| D-34 | The bill carries the supplier invoice total: a difference inside the tolerance is posted as the bill's `adjustment`, and a bill whose total still differs is reported with a note. | The earlier automation billed the PO value, which left bills that disagreed with the supplier's document. |
| D-35 | Write order: create → open → attach → verify → delete the inbox file. A failed attachment leaves `BILLED_NO_ATTACH`, retried as attach-only. | The inbox file is the only copy of the document until it is attached to the bill. |
| D-36 | Carriage on a PO without a carriage line is booked on `CARRIAGE_ITEM_ID` when the organisation has one carriage item, else on `CARRIAGE_ACCOUNT_ID` (the freight purchase account), else on the first line's account. | Some organisations keep one carriage item per supplier or brand, all posting to one freight account. Picking "the supplier's item" is ambiguous; the account is not. |
| D-37 | Payment terms: when no term has the PO's (days, label) pair but the label names exactly one term of the organisation, the bill uses that term. | Books returns special terms such as "due end of next month" on a PO as 0 days plus the label; sending 0 would make the bill due on receipt. |
| D-38 | Credit notes become vendor credits: lines mapped to the PO's lines, total verified (the draft is deleted on a mismatch), applied to the bill named on the note or to the PO's single bill, otherwise left against the PO and reported. Supersedes an initial manual-only `CREDIT_NOTE` reason. | A credit must never sit outside Books, and an unallocated one must be visible. |

## State and reliability

| # | Decision | Why |
|---|---|---|
| D-39 | Exceptions stay in the Books inbox; state lives in the Catalyst Data Store; new documents are always processed before retries. | The inbox is the queue finance already uses, there is no documented API to move files between folders, and fresh invoices must never wait behind a backlog of exceptions. |
| D-40 | Reconciliation window: open documents are re-evaluated every 6 hours for up to 28 attempts — one week — reusing the stored extraction. | A PO fixed hours or days later must bill itself without raising the AI cost. |
| D-41 | Service errors (`AI_ERROR`, `BOOKS_ERROR`, `ATTACH_FAILED`) retry on the next run; a `PROCESSING` claim older than `LOCK_STALE_MINUTES` is a retry candidate. | A dead run must not park documents for hours, and service errors are not the finance team's problem. |
| D-42 | Dry-run results (`WOULD_BILL`, `WOULD_CREDIT`) are retry-eligible. | The first live run bills what the dry runs matched, without a manual reset. |
| D-43 | ROWIDs are never taken from insert or update responses; they are re-read through ZCQL after every insert, and every update response is verified. | ROWIDs are 17 digits, beyond 2^53. The REST responses carry them as JSON numbers, so `JSON.parse` rounds them and updates hit the wrong row or none. |
| D-44 | `reason_code` and `reason_text` are written as empty strings when a document reaches a clean status. | Data Store partial updates leave absent columns untouched, so a billed row kept the reason of its last failed attempt. |
| D-45 | Notes of a clean outcome are stored in `reason_text` (with an empty `reason_code`) and shown under the bill in the daily digest. | The digest reads the state table, not the run, so "matched by value — add this code", "billed below the PO price" or "carriage left open" would otherwise never reach finance. Reusing the column avoids a schema change in two environments. |
| D-46 | Data Store writes never mutate SDK error objects; they are wrapped with a code and status, and transient failures (5xx, 429, network) are retried with backoff. | The SDK's errors expose getter-only properties, and its rejections are sometimes plain strings. |
| D-47 | All log levels go to stdout as structured single lines carrying the run id; secrets are redacted by key name. | Catalyst does not show stderr for job functions. |
| D-48 | `SCAN_SINCE`: inbox documents created before the configured moment are never read, recorded or reported; an unparsable creation time is treated as old. | A historical backlog must not be touched, and the safe reading of an ambiguous date is "do not process". |

## Reporting and operations

| # | Decision | Why |
|---|---|---|
| D-49 | One digest email per local day, sent by the first run after `DAILY_REPORT_HOUR`; per-run reports go to the log unless `REPORT_PER_RUN` is set. | Finance wants one readable end-of-day email, not one per run. Using the regular run as the trigger avoids a second schedule. |
| D-50 | The digest marker is a `run_log` row written only after a successful send. | A failed send is retried by the next run; a successful one is never repeated. |
| D-51 | Real documents are tested through `scripts/golden.js` (reader only) and `scripts/replicate.js` (pull read-only → check offline → push to the sandbox → verify), all inside a git-ignored folder. | The purchase orders behind real invoices can be rebuilt in the sandbox with their own numbers, and no business document or snapshot ever reaches the repository. |
| D-52 | Scripts that write to Books refuse to run unless `BOOKS_ORG_ID` equals `SEED_ALLOW_ORG_ID`; local scripts always use the plain (sandbox) variables. | A guard against seeding or testing against a live organisation by mistake. |
