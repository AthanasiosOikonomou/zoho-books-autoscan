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
