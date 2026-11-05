# Decisions

| Date | Decision | Why |
|---|---|---|
| 2026-11-03 | Rebuild on Catalyst (Node.js), not repair the Deluge function | Deluge runtime caps, single-page inbox read, no state; see architecture.md |
| 2026-11-03 | Claude Haiku (cost-first); Sonnet only as an explicit config switch | ~$0.001/invoice; golden-set test decides if a stronger model is ever needed |
| 2026-11-03 | Dedupe on vendor + supplier invoice number, never on "PO already has a bill" | One PO is billed by several supplier invoices (partial deliveries) |
| 2026-11-03 | Exceptions stay in the Books inbox; state lives in Catalyst Data Store; new docs always processed before retries | The queue behaviour the client requires in writing; no undocumented folder-move API |
| 2026-11-03 | Build and test in the Books sandbox org + Catalyst Development env; the client disables the old scheduler at UAT | Client instruction |
| 2026-11-03 | Token scope `ZohoBooks.fullaccess.all`; read-only protection via the Books user role, not the scope | Documents API has no granular scope |
| 2026-11-03 | Phase 1 also matches the invoice against the PO's remaining value | Lets the closing invoice of a manually part-billed PO auto-match |
| 2026-11-04 | ROWIDs are never taken from insert/update responses; re-read through ZCQL after every insert, every update response verified | ROWIDs are 17 digits (> 2^53); the REST responses carry them as JSON numbers, so `JSON.parse` rounds them and updates hit the wrong row or none |
| 2026-11-04 | `PROCESSING` claims older than `LOCK_STALE_MINUTES` are retry candidates; `AI_ERROR` / `BOOKS_ERROR` / `ATTACH_FAILED` retry on the next run | A dead run must not park documents for 12 h; service errors are not the finance team's problem |
| 2026-11-04 | Total tolerance is £1 on the invoice total (was 2p) | Client rule |
| 2026-11-04 | The bill carries the supplier invoice total, not the PO's: the difference inside the tolerance is posted as the bill's `adjustment`; a bill whose total still differs is reported with a note | Client rule — the previous implementation billed the PO value |
| 2026-11-04 | Credit notes get their own reason `CREDIT_NOTE` (manual for now) | Suppliers send credit notes, sometimes tied to a bill, always with the PO number; automation is a later phase |
| 2026-11-04 | Reconciliation window: exceptions re-checked every 6 h for up to 28 attempts (a week), reusing the stored extraction | A PO fixed hours or days later must bill itself without raising the AI cost |
| 2026-11-04 | Credit notes → Books vendor credits: lines by MPN against the PO, total verified (draft deleted on mismatch), applied to the bill named on the note or the PO's single bill, else PO only + report line | Client rule; a credit must never sit outside Books |
| 2026-11-04 | One digest email per local day, sent by the first run after `DAILY_REPORT_HOUR`; per-run reports stay in the log | Finance asked for one readable end-of-day email, not one per run |
| 2026-11-05 | Line matching keys: the item custom field "Supplier Reference" on the PO line first, then item MPN, SKU, item code — all compared with case, spaces, dots, dashes and slashes removed | Production POs print both Supplier Reference and MPN; suppliers print their own code, sometimes with different punctuation (`ZK410-KIT` vs `ZK410KIT`) |
| 2026-11-05 | Vendor carriage rule and tolerance are read by field *label*, not API name | Sandbox custom fields are named `cf__sb_<org>_…`, production `cf_…` |
| 2026-11-05 | Phase 2 bills carry the invoice: invoiced quantities, invoice unit prices (within tolerance, or lower when accepted), invoice carriage; a PO with no coded lines falls back to the total match | Client rule "bill = invoice"; partial deliveries are routine; many items still lack a Supplier Reference / MPN |
| 2026-11-05 | `reason_code` / `reason_text` are written as `''` when a document reaches a clean status | Data Store partial updates leave absent columns untouched, so a BILLED row kept the reason of its last failed attempt |
| 2026-11-05 | Price policy stays configurable (`LINE_PRICE_TOLERANCE_PCT`, `ACCEPT_LOWER_PRICE`) with placeholder values until the client answers | Asked by email on 5 Nov; changing the policy is an env change, not a release |
