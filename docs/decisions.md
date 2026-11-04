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
