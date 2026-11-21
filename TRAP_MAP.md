# Brim AP dataset: trap map

What's planted in the Harborline dataset (as-of date 2026-11-02). Found with a first pass of scripts. Double-check each one before you demo it.

Use this as the test checklist: when the app catches every row, the core is done.

## 1. Fraud and vendor problems

| Where | What | What the app should do |
|---|---|---|
| Cascadia Cartage (V004), invoices 1624 (scan_8049.png) and 1625 | Bank details changed **2026-10-27 by email, not verified by callback** (BC-009). Both invoices pay into the new account ...9679. | Hold both. Make someone call the vendor at the old phone number on file. |
| "Harlow **and** Stern LLP" (V052), invoice HA26-2766, email EM-026 | A look-alike of the real **Harlow & Stern LLP (V026)**. Different domain (harlowandstern-llp.example), different GST number, different bank. **It's already active in the vendor master.** | Flag near-duplicate vendors. Block it. |
| Great Lakes Carriers **Incorporated** (V053) | Duplicate vendor record of Great Lakes Carriers Inc. (V002), with the same email and bank. Status on_hold. | Flag duplicate vendor records when onboarding. |
| Blue Heron Couriers (Invoice 4443) and Zephyr Data Services (7590) | **Not in the vendor master.** | Route to onboarding and hold. |
| Riverbend Catering (V054), invoice 1739 | Vendor is **pending_review**, has no GST number and charges no tax. | Hold until the vendor is approved (needs the extra finance-manager step, P05). |

## 2. Duplicates (incoming)

| Invoice | Duplicate of |
|---|---|
| Polar Freight 000961 | AP-00393, already paid |
| Harlow & Stern 001468 | AP-00389, already paid |
| Cloudbarn INV-01561 | AP-00370, already paid **by Brim virtual card** |
| Voyageur 000903-A | AP-00277 #000903, same amount. The "-A" suffix is a reformatted duplicate. Already paid by card. |
| Brightline 583 | AP-00330 #FA-000583 (reformatted number). Dated Aug 12. |

## 3. Duplicates and double payments already in the history (money to claw back)

- **About to pay twice:** AP-00394 and AP-00407, Summit #000804, $2,457.19, **both scheduled**.
- Paid twice by EFT: AP-00023/AP-00034 (INV-02990), AP-00073/AP-00077 (#000604 vs #604), AP-00136/AP-00155 (FA-001655 vs 1655-A), AP-00215/AP-00224 (AL26-0663).
- Paid by EFT **and** on an employee card: Paper Trail (CT-00017, CT-00026, CT-00318, CT-00383) and Alpenglow (CT-00324, CT-00551). AL26-0663 was paid **three times**.
- Overpaid in 2026, roughly **$23.6k**. That makes a strong demo stat.

## 4. Money and tax errors

| Invoice | Problem |
|---|---|
| Evergreen Energy 000850 | $3,180 + $159 = $3,339, but the total says **$3,439** ($100 off) |
| Northstar Media NO26-1773 | 24 × $150 = $3,600, but the line says **$3,800** |
| Polar Freight 000964 | Fuel surcharge **22%**, but the contract caps it at 12% (C018) |
| Northbound Couriers 000639 | Shipped to **AB** but charged **13% HST** (should be 5% GST) |
| Ironwood Pallet INV-02210 | Shipped to **ON**, goods, **no tax charged at all** |
| Beaumont Rivière FA-000557 | Shipped to **QC**, but **no QST** charged |
| Signal & Sparrow 000970 | **BC PST 7% on services.** PST applies to goods only here. |
| Aurora Mobile AU26-2207 | $2,343.50 vs contract **$2,150**/month (C008) |
| Pinecone PI26-2809 | $826.80 vs contract **$780**/month (C003) |
| Lattice Ledger 557 | $8,200 "implementation" on a $1,320/month fixed contract. Not covered by the contract, needs review. |
| Summit 000809 | Invoice dated **2026-11-27, in the future**. It's also over its PO. |
| Lumen Print FA-001761 | Dated **April 2026**. Stale or late invoice. |
| Prairie Natural Gas (scan_8749.png) | Poor scan. OCR misreads the GST number ("RT000!") and the transit ("$5541" instead of 55541). |

## 5. Approval-rule traps

- **Split invoices to stay under the $10k limit:**
  - Orion Strategy sent 279 + 281 + 287 on the same day (network audit phases 1–3, about $14.5k total).
  - In the history: Northstar "Fall launch part 1/part 2" (AP-00303/AP-00304), and Deskhive furniture split over 3 invoices in 4 days (AP-00120/AP-00129/AP-00131, about $22.8k).
- **Self-approval in the history:** Wen Zhao (U010, IT manager) approved his own requests: AP-00092, AP-00178, AP-00235.
- **Delegation clash:** Liam O'Connor (U012, Facilities manager) is **on leave since 10-20**. His delegate is **Elise Tremblay (U003), the finance manager**, who also releases payments.
  - For a Facilities invoice over $10k, she would be step 1 (as delegate) **and** step 2 (as finance manager), and could not then release the payment.
  - Test it with Queen Street rent 002935 ($18,758, Facilities).
- **Contract expired:** Torque Industrial 1771. Contract C025 ended 2026-06-30, and the invoice is over what's left on PO-2026-0037 ($5,000 PO, $3,200 already invoiced).

## 6. PO matching

None of the incoming invoices print a PO number. For vendors that require a PO, match to the vendor's open PO and check the remaining balance (P12/P13):

| Invoice | Open PO | Result |
|---|---|---|
| Keystone KE26-1198 | PO-0046 ($6,803.89) | within |
| Summit 000809 | PO-0052 ($5,500) | **over** ($5,748.75 with tax) |
| Alpenglow AL26-0689 | PO-0050 ($6,105.19) | **over** with tax |
| Ironwood INV-02210 | PO-0051 | within |
| Riverbend 1739 | PO-0047 | within |
| Fixwell FA-000415 | PO-0049 | within |
| Torque 1771 | PO-0037 | **over** the remaining $1,800 |
| Hardhat 853 | **none open** | **hold** |
| Brightline 583 | **none open** | **hold** |

Decide as a team whether PO balances are compared before or after tax, and be ready to explain it in the Q&A.

## 7. Credit notes

- Fixwell CN-FA-000413, -$1,614.21. It exactly reverses FA-000410 (AP-00383, paid).
- Great Lakes CN-GR26-2274, -$672, references GR26-2262 (AP-00358, paid).
- Both should be applied against the next payment to that vendor, not paid out.

## 8. Inbox (59 emails)

| Email | What it is | What the app should do |
|---|---|---|
| EM-059 | Deskhive furniture sale newsletter | Ignore |
| EM-056 | Polar Freight statement of account, no action needed | File it, don't create an invoice |
| EM-058 | Brightmore Consulting "invoice attached", **no attachment**, unknown vendor | Reply asking for the invoice |
| EM-057 | Torque asks **"where is payment for invoice 1743?"** | **Already paid:** PAY-00047, EFT, settled 2026-03-09. Perfect for an auto-reply. |
| EM-029 | **Two invoices in one email** (279 and 281) | Create two invoices |
| Many | Subject and body in mixed French/English (e.g. "Facture" subject with an English body) | Detect the language per document, not per email |

## 9. USD invoices

- Sparkgrid FA-002342 ($1,950) and Tessera 002715 ($3,100).
- Foreign vendors, no Canadian tax.
- Convert with fx_rates.csv on the invoice date.
- Both vendors prefer card payment.
