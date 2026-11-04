# Requirements (confirmed by the client, 4 Nov 2026)

What the client's finance lead confirmed in writing, and where each point stands in the code. Wording is client-neutral on purpose (public mirror).

| # | Requirement | Status | Where |
|---|---|---|---|
| 1 | Supplier invoices arrive as PDF attachments in the purchase-ledger mailbox and are forwarded into the Books **Documents inbox** | Assumed input; the function reads `documents?view=inbox` | `src/books/client.js` |
| 2 | Each invoice is brought into Books and matched to the correct PO; **no PO in Books = failed match → manual review** | Done — `PO_NOT_FOUND` / `NO_PO_REF`, re-checked every 6 h for a week in case the PO is created later | `src/pipeline/resolvePo.js`, `reasons.js` |
| 3 | Invoices quote the PO as a **6-digit reference**, sometimes prefixed `PO-`; in Books the POs are numbered `PR-00123` (prefix + zero-padded sequence) | Done — the resolver tries the raw value, prefix + digits, zero-padded, the legacy `IPO/` shapes and the PO `reference_number`; the Books shape is passed to the model from config. Production: `PO_PREFIX=PR-`, `PO_PAD_WIDTH=5`. **To verify on the golden set:** which of the two numbers suppliers actually print, and whether the 6-digit reference lives in the PO's `reference_number` | `resolvePo.js`, `prompt.v7.md`, `config.js` |
| 4 | Verify PO number, MPN, line quantity, price, total | Phase 1: PO number + total (or the PO's remaining value). **Phase 2**: MPN, qty, price per line | `match.js` (Phase 2 flagged `PHASE2_ENABLED`) |
| 5 | On match: create the Bill under the correct vendor, linked to the PO, with the invoice attached | Done — bill from the PO template, attachment verified before the inbox file is deleted | `bill.js`, `processDocument.js` |
| 6 | **Bill date = the date on the supplier invoice**, never the received/processed date | Done | `bill.js` (`date: invoiceDate`) |
| 7 | Not matched confidently → manual review by the finance team | Done — `LOW_CONFIDENCE` below `CONFIDENCE_THRESHOLD`, every exception carries a reason and an action | `reasons.js`, report |
| 8 | **Carriage variance**: configurable per supplier — zero tolerance / absolute £ tolerance per supplier / excluded from matching (PO carriage often bears little relation to the invoiced amount, e.g. £15 on £150) | **Phase 2** — vendor custom fields *Carriage Rule* / *Carriage Tolerance*; seed scenarios `carriage_zero`, `carriage_fixed`, `carriage_ignore` exist | planned in `match.js` |
| 9 | **Partial invoicing**: suppliers ship and invoice part of an order; today invoices are held until the order completes → line-level matching on **MPN**, one PO satisfied across several invoices | **Phase 2** — line matching + partial bills from invoiced quantities; Phase 1 already accepts the closing invoice of a part-billed PO (remaining-value match) | `match.js`, `bill.js` (`quantities`) |

Additional rules from the project lead (4 Nov 2026):

- Total tolerance **£1** on the invoice total; the bill carries the **invoice** total (difference to PO-priced lines posted as the bill's adjustment). Done.
- Credit notes (always with the PO number, sometimes against a specific bill): create a **vendor credit** in Books — linked to the bill when the bill and PO are found, otherwise to the PO only — and say in the report "credit note X created, not linked to any bill". Flagged as `CREDIT_NOTE` until built (next phase).
- Books API budget is not a constraint: the client's Zoho One plan allows 10,000 calls/day plus a 200,000/day add-on.
- UAT exit: the client (project coordinator + accountant) switches the old Deluge schedule off only after UAT with all findings resolved.
- One **end-of-day** report email with bills created (links), amount mismatches and unmatched POs, as a clean HTML dashboard — once the client's mailbox exists.
- Fixing a PO hours or days later must bill the document automatically without extra AI cost. Done (stored extraction, 6 h × 28).
