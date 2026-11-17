# Business rules

What the automation must do, stated in the terms a finance team would use, with the reason behind each rule, the switch that controls it and where it lives in the code. These rules were agreed with the finance team that uses the system and verified against real supplier documents in a sandbox.

Defaults are shown in brackets. Every switch is described in [`configuration.md`](configuration.md); the reason codes are listed in [`operations.md`](operations.md#statuses-and-reason-codes).

## 1. Intake

| Rule | Why | Where |
|---|---|---|
| Supplier invoices and credit notes arrive as attachments in a purchase-ledger mailbox and are forwarded into the Books **Documents inbox**. The inbox is the only input. | Finance already works from that inbox; no new upload step is introduced. | `src/books/client.js` |
| Documents created before the go-live cutoff are never read, recorded or reported. `SCAN_SINCE` | A historical backlog must stay untouched; without a cutoff the first live run would start on the oldest files. | `src/pipeline/run.js` |
| Documents already linked to a transaction in Books are skipped. | They have been handled by hand. | `src/pipeline/run.js` |
| Files that are not PDF, JPG or PNG, and documents longer than the page cap, go to manual handling. `CLAUDE_PAGE_CAP` [6] | Long documents are statements or catalogues, not invoices; reading them wastes money. | `src/pipeline/processDocument.js` |

## 2. The purchase order is mandatory

| Rule | Why | Where |
|---|---|---|
| Every invoice must be matched to a purchase order that exists in Books. No PO in Books means a failed match and manual review. It is never assumed that the PO "exists under another number". | A bill without a PO has nothing to be checked against. | `src/pipeline/resolvePo.js` |
| The PO reference is taken as printed and resolved against both the PO number and the PO's reference field, in the organisation's current numbering and in any legacy format still quoted by suppliers. `PO_PREFIX`, `PO_PAD_WIDTH`, `PO_LEGACY_PREFIXES` | Suppliers keep quoting old reference formats for years; both numbering schemes coexist in Books. | `src/pipeline/resolvePo.js` |
| A supplier's own sales-order number is never treated as the customer's PO reference. | The two are printed side by side and look alike. | `src/claude/prompt.v7.md` |
| A document whose PO is missing or wrong is re-checked automatically once the PO is created or corrected — hours or days later — without another AI call. `RETRY_AFTER_HOURS` [6], `MAX_ATTEMPTS` [28] | Finance fixes the PO in Books and should not have to touch the document again. | `src/pipeline/run.js`, `src/state/store.js` |

## 3. Totals

| Rule | Why | Where |
|---|---|---|
| The invoice total may differ from the expected total by at most the tolerance. `TOTAL_TOLERANCE` [1.00] | Rounding differences of pence are normal; anything larger needs a person. | `src/pipeline/match.js`, `src/pipeline/lines.js` |
| The bill carries the **supplier invoice's** value, not the purchase order's. Any difference inside the tolerance is posted as the bill's adjustment. `BILL_ADJUST_TO_INVOICE` [true] | The bill must agree with the document the supplier will chase payment for. | `src/pipeline/bill.js` |
| When line matching is off or not possible, the invoice total is compared with the PO total, and also with the PO's remaining un-billed value. `MATCH_AGAINST_REMAINING` [true] | The closing invoice of a PO that was partly billed by hand should still match. | `src/pipeline/match.js` |

## 4. Line matching

Enabled with `PHASE2_ENABLED` [false]. All lines must pass, or the whole document goes to review with the detail of every failing line.

| Rule | Why | Where |
|---|---|---|
| An invoice line is matched to a PO line by the **supplier's own code**: the item custom field *Supplier Reference* first, then the item MPN, then SKU and item code. `SUPPLIER_REF_LABEL` | The supplier's code is the only identifier printed on both documents. Descriptions differ between supplier and customer. | `src/pipeline/lines.js` |
| Codes are compared ignoring case, spaces, dots, dashes, slashes and underscores. | Suppliers print the same code with different punctuation (`ZK410-KIT` on the invoice, `ZK410KIT` on the PO). | `normCode()` in `lines.js` |
| The invoiced quantity may not exceed what is ordered and not yet billed on that PO line. | Over-delivery or a double invoice needs a person. | `lines.js` → `QTY_EXCEEDS` |
| A PO line ordered as a pack and invoiced as single units is recognised when the money agrees to the penny and the quantities differ by a whole factor. | Suppliers invoice 6 × each where the PO says 1 × pack of 6. | `packUnits()` in `lines.js` |
| The unit price is derived from the line total when the printed price does not multiply up to it. Rows printed at 0.00 that carry no product are ignored. | Prices are quoted per litre, per hundred, or before a line discount; couriers appear as zero-value rows. | `lines.js` |
| A PO whose lines carry no code at all is matched on totals instead, and the report says so. | Item data is completed over time; the automation must still work meanwhile. | `lines.js` → note `NO_MPN` |

## 5. Price policy

| Rule | Why | Where |
|---|---|---|
| A line invoiced **below** the PO price by up to the tolerance is billed at the invoice price, and the report notes it. `LINE_PRICE_TOLERANCE_PCT` [5] | A lower price is in the organisation's favour and usually a legitimate discount. | `lines.js` |
| A line invoiced **above** the PO price goes to review, however small the increase. `LINE_PRICE_TOLERANCE_UP_PCT` [0] | Price increases must be seen and accepted by a person. | `lines.js` → `PRICE_MISMATCH` |
| A line more than the tolerance below the PO price also goes to review. | A large drop is more likely a wrong item or unit than a discount. | `lines.js` → `PRICE_MISMATCH` |
| A penny of rounding in either direction is ignored. `LINE_PRICE_TOLERANCE_ABS` [0.01] | Unit prices are rounded differently by each system. | `lines.js` |

## 6. Carriage

Carriage on the PO is a line item. The invoice's carriage is compared with what is still open on that line.

| Situation | Outcome | Why |
|---|---|---|
| Invoice carriage is **at or below** the PO's | Billed as invoiced on the PO's carriage line, which completes that line and lets the PO complete. `CARRIAGE_BELOW_PO_OK` [true] | A lower charge is never a problem and should not leave the PO open. |
| **No carriage** on the invoice, carriage on the PO | The goods are billed; the PO stays partially billed. | The supplier is expected to invoice carriage separately. |
| A later **carriage-only invoice** | Bills just the open carriage line. | Closes the PO left open above. |
| Invoice carriage is **above** the PO's | Decided per vendor (below). | PO carriage is often an estimate; how much variance is acceptable differs by supplier. |
| The PO's carriage line was already billed by an earlier shipment | Treated as nothing open, so further carriage counts as "above". | A second part-shipment charging carriage again is an extra cost. |
| The PO has no carriage line and carriage is accepted | Added to the bill as its own line, booked on the configured carriage item or freight account. `CARRIAGE_ITEM_ID`, `CARRIAGE_ACCOUNT_ID` | Some organisations keep one carriage item for all suppliers, others one per supplier posting to a shared account. |

**Per-vendor rule for carriage above the PO.** Finance maintains two custom fields on the vendor in Books:

| *Carriage Rule* | Meaning |
|---|---|
| `Zero` | No carriage above the PO is accepted. This is the default for a vendor with nothing set. `DEFAULT_CARRIAGE_RULE` |
| `Fixed` | Accepted up to *Carriage Tolerance* above the PO. |
| `Ignore` | Any carriage is accepted. |

The fields are found by their label (`CARRIAGE_RULE_LABEL`, `CARRIAGE_TOLERANCE_LABEL`), because the same field has a different API name in a sandbox and in production. All purchase orders are treated the same way, whoever or whatever raised them; there is no per-PO override. Code: `src/pipeline/vendorRules.js`, `lines.js` → `CARRIAGE_MISMATCH`.

## 7. Surcharges

| Rule | Why | Where |
|---|---|---|
| A **product surcharge** ("Product surcharge 5 %", "Order surcharge") is part of the product price, not carriage. It is spread over the product lines by value before the price check. `SURCHARGE_IN_PRICE` [true] | Surcharges are meant to be worked into the item prices on the PO, so the invoice must still agree with the PO price. | `isProductSurcharge()`, `splitCharges()` in `lines.js` |
| If the PO price already contains the surcharge the line matches; if it does not, the line is a price increase and goes to review. | It exposes PO prices that were entered without the surcharge. | `lines.js` → `PRICE_MISMATCH` |
| A surcharge that names the delivery ("Fuel surcharge", "Delivery surcharge") stays carriage. | It is a delivery cost. | `lines.js` |

The classification is made in code from each charge's printed description; the document reader only lists the charges. That keeps every stored reading valid when the rule changes.

## 8. Items without a supplier code

The supplier's code always comes first. Only when an invoice line matches no code may it be matched **by value**, and only when all of these hold. `LINE_VALUE_FALLBACK` [true]

- the PO line's item has no *Supplier Reference* and no MPN;
- it is the only open PO line with the same unit price (or the same money as a whole pack) and enough open quantity;
- no other invoice line could claim it;
- the two descriptions share a word.

The report names the code to add to the item so the next invoice matches properly. Two candidates — the same product in two colours at one price — go to review as `LINE_UNMATCHED`. A description alone is never accepted as a key for money; a unique value is.

## 9. Partial deliveries

Suppliers ship and invoice an order in parts. Each supplier invoice becomes its own bill linked to the same PO, for the quantities actually invoiced; Books tracks what is still open per line and moves the PO from partially billed to billed. One PO can therefore carry several bills, and "the PO already has a bill" is never a reason to reject an invoice.

## 10. What the bill looks like

| Field | Value |
|---|---|
| Vendor | The vendor of the purchase order. |
| Bill number | The supplier's invoice number exactly as printed, leading zeros and punctuation included. |
| Bill date | The date printed on the supplier invoice — never the date the document was received or processed. |
| Payment terms | Those of the purchase order. |
| Lines | Phase 1: the PO's lines. Phase 2: the invoiced quantities at the invoice prices, plus the invoiced carriage. |
| Status | Open. |
| Attachment | The supplier's document. The inbox copy is removed only after the attachment is verified. |

## 11. Duplicates

The same supplier invoice number for the same vendor is never billed twice — checked against the bills in Books and against the other documents of the same run. The duplicate file is left in the inbox, flagged, and never deleted automatically.

## 12. Credit notes

| Rule | Why |
|---|---|
| A supplier credit note becomes a **vendor credit** in Books, with the document attached. | A credit must never sit outside Books. |
| It is applied to the bill it refers to when that bill can be identified — by the invoice number printed on the note, or because the PO has exactly one bill. | That is how finance would allocate it. |
| Otherwise it is created against the PO only, and the report says the credit note is not linked to any bill. | Someone has to allocate it by hand, and must be told. |
| If Books prices the credited lines differently from the printed total, the draft is removed and the document goes to review. | A wrong credit is worse than none. |
| The same credit note number twice is a duplicate. | Same reasoning as for invoices. |

Code: `src/pipeline/creditNote.js`.

## 13. When a person decides

Anything not matched with confidence goes to manual review: a reading below `CONFIDENCE_THRESHOLD` [0.75], a missing PO reference, a document that is not an invoice, or any failed check above. The document stays in the inbox, and the report gives the reason, what was read against what the PO says, and the action to take.

## 14. Reporting

One email at the end of the day, readable by someone who never opens a log: bills created with links into Books, vendor credits and whether each is linked to a bill, everything still waiting grouped by reason with the action and how long it has waited, duplicates, and the day's cost. A bill created with a remark — billed below the PO price, matched by value, carriage left open, surcharge folded into the price — shows that note. `DAILY_REPORT_HOUR` [17], `REPORT_TIMEZONE`. Code: `src/report/daily.js`.

## 15. Deliberately not done

- **Historical documents.** Everything before the go-live cutoff is ignored.
- **Per-PO carriage overrides.** The vendor-level rule is the only rule.
- **An item-data readiness list.** The report already names the code to add whenever a line had to be matched by value.
- **Automatic acceptance of price increases.** Possible through configuration, off by default.
