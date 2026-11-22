# Harborline AP — CodeJam 16 (Brim Financial challenge)

This is a web app that takes a supplier invoice from the inbox to a payment: intake → read → code → check → approve → pay. Every step is audited.

The fictional customer is **Harborline Logistics**, a 40-person Canadian logistics company with about 55 vendors and about 50 invoices a month. Payments are **simulated**: no real money and no real bank APIs.

This file is the project brief for anyone working in this repo, human or Claude Code. Read it before writing code.

---

## How we're judged (this decides priorities)

| Weight | Criterion | What it means for us |
|---|---|---|
| 40% | Required features working | Cover all 9 roughly before polishing any one. Working beats perfect. |
| 25% | Technical depth (live Q&A) | Every team member must be able to explain every design choice, **including AI-written code**. Keep code simple and comment the *why*. |
| 20% | Clean, intuitive UI | Use one component library and stay consistent. |
| 15% | Bonus features | Only count once the required features work. Do them last. |

**Rule for Claude Code:** prefer the simplest solution a teammate could explain in 30 seconds. No clever abstractions, no extra frameworks, no premature optimization.

---

## Stack

Chosen to look like a real AP system (a judging criterion), while staying small enough to explain.

- Frontend: React + Vite + TypeScript, Ant Design as the only component library (`frontend/`).
- Backend: Python 3.12 + FastAPI, plain SQL through psycopg 3, no ORM (`backend/app/`).
- Database: Postgres 17. Money is integer cents. The audit table is append-only, enforced by a trigger.
- Extraction: an OCR worker (step 2) that reads the PDF text layer, falls back to Tesseract OCR for scans, and
  parses fields with deterministic code. It pulls jobs from a Postgres table (`FOR UPDATE SKIP LOCKED`), so
  workers can run on other machines.
- LLM provider: **none.** No LLM API key, and none will be added. See the architecture principles.
- How to run locally: `make up` (= `docker compose up --build`). UI on http://localhost:5173, API docs on
  http://localhost:8000/docs. Needs Docker only.
- How to seed the data: automatic on first start. `make reseed` wipes and reloads. `make test` runs the tests
  against a separate `ap_test` database.

---

## Data

The dataset lives in `data/brim_ap_dataset/`. It is synthetic. **As-of date: 2026-11-02.** History runs from January to October 2026.

| File | What it is |
|---|---|
| `data/users.csv` | 40 users: role, manager, `approval_limit_cad`, status (`active` / `on_leave` / `terminated`), `delegate_user_id` |
| `data/departments.csv` | 8 departments, each with a manager and a budget |
| `data/vendors.csv` | 56 vendors: GST/QST numbers, bank details, `requires_po`, status (`active` / `pending_review` / `on_hold`) |
| `data/bank_change_history.csv` | Vendor bank changes: channel, and whether they were verified by callback |
| `data/approval_policies.csv` | Rules P01–P13 (see below) |
| `data/gl_accounts.csv` | Chart of accounts |
| `data/tax_codes.csv` | `HST13`, `GST5`, `PST7_BC` (goods only), `QST9975`, `EXEMPT`, `FOREIGN` |
| `data/contracts.csv` | Fixed monthly fees, hourly rate caps, fuel surcharge caps, not-to-exceed limits |
| `data/purchase_orders.csv` | POs with status (`open` / `partially_invoiced` / `closed`) |
| `data/invoices.csv`, `data/invoice_lines.csv` | About 426 historical invoices and their lines. Use these to train GL/department coding. |
| `data/approvals.csv` | Historical approval steps |
| `data/payments.csv` | Historical payments (`EFT` / `CHEQUE` / `CARD`) |
| `data/bank_statement.csv` | Bank debits and credits (EFT and cheque) |
| `data/card_transactions.csv` | Employee cards and AP single-use Brim virtual cards |
| `data/fx_rates.csv` | Daily USD→CAD rates |
| `incoming_invoices/` | 56 unprocessed invoices: PDFs plus 2 PNG scans, in English and French |
| `inbox/emails.json` | 59 unprocessed AP inbox emails, with attachments referenced by filename |

### Tax rules (as given by the brief, not real-world tax advice)

- The place of supply is `ship_to_province`, the province the goods or services are delivered to. For incoming invoices, take it from the **Bill to** address.
- **ON:** HST 13%.
- **AB, BC:** GST 5%. BC also adds **PST 7% on goods only**, and PST is not recoverable.
- **QC:** GST 5% plus **QST 9.975% on the pre-tax amount**.
- Insurance is exempt. Foreign (US) vendors charge no Canadian tax.
- GST/HST is recoverable to GL 1160 and QST to GL 1165.
- USD invoices convert to CAD at the `fx_rates.csv` rate **on the invoice date**.

---

## Business rules (enforce on the server, never only in the UI)

### Roles

`employee`, `ap_clerk`, `approver` (department manager), `finance_manager`, `controller_admin`, `auditor` (read-only).

### Approval routing (`approval_policies.csv`)

| Rule | Condition | Who must approve |
|---|---|---|
| P01 | Total ≤ $10,000 CAD | Department manager |
| P02 | Total > $10,000 | Department manager, then finance manager |
| P03 | Total > $50,000 | ...then controller |
| P04 | Total > $250,000 | ...then CFO |
| P05 | Vendor is `pending_review` or new | Extra finance manager step, whatever the amount |
| P06 | Vendor category is Legal | Extra finance manager step, whatever the amount |
| P07 | Requester would be the approver | Escalate to the approver's manager. **No self-approval.** |
| P08 | Approver is on leave | Route to their `delegate_user_id` and **record that it was a delegation** |

### Payment release

| Rule | Condition | Who can release |
|---|---|---|
| P09 | Payment ≤ $100,000 | Finance manager. AP clerks prepare payments but **cannot release** them. |
| P10 | Payment > $100,000 | Controller |
| P11 | Always | **Whoever approved the invoice cannot release its payment** (separation of duties) |

### Matching

| Rule | Condition | What happens |
|---|---|---|
| P12 | Invoice references a PO | The total must fit within the PO's remaining balance. Over-balance invoices go to the finance manager. |
| P13 | Vendor `requires_po` and no PO | **Hold** |

### Other non-negotiables

- One person can't fill two approval steps on the same invoice. If a delegate is also the next approver, escalate.
- Unapproved, on-hold or unknown vendors can't be paid.
- A vendor bank change takes effect only after **callback verification**. Payments to that vendor are held until then.
- Every state change writes an audit event (see below).

---

## The 9 required features

1. **Intake.** Accept uploads and read `inbox/emails.json`. Ignore or route non-invoice emails (newsletters, statements, payment-status questions, emails missing an attachment). An email can contain more than one invoice.
2. **Extraction.** Pull vendor, invoice #, dates, lines, subtotal, taxes, total, currency, GST/QST numbers and remit-to bank details from English and French PDFs and from scans. Map the taxes to tax codes. Show a confidence level and let a person correct fields.
3. **Smart coding.** Suggest a GL account and department, learned from historical `invoice_lines.csv` and the vendor's `default_gl_account`. Show the reason ("8 of 9 past invoices from this vendor went to 5010") and allow an override.
4. **Validation and matching.** Check against the vendor master, contracts and POs. Run tax checks by province and arithmetic checks (lines sum to the subtotal, the subtotal plus tax equals the total, each tax equals its rate × the subtotal).
5. **Duplicate detection.** This includes reformatted numbers (`583` vs `FA-000583`, `000903-A` vs `000903`) and invoices already paid by card (`card_transactions.csv`).
6. **Approval workflow.** Configurable rules (P01–P08), delegation, absence handling, and one history view per invoice.
7. **Payments.** Simulated EFT, with release limits by role (P09–P11), a dashboard, and a status for each payment.
8. **Audit trail.** Every payment links to its invoice, approvals, GL codes and the user who did each step.
9. **Vendor management.** Onboarding, holding unapproved vendors, controlled bank-detail changes with callback verification, and detection of near-duplicate vendors.

### Suggested build order

1. Seed all CSVs into the database.
2. Get one invoice through every stage end to end, even if it's ugly.
3. Fill in each stage.
4. Polish the UI.
5. Add bonus features.

---

## Architecture principles

- **No LLM anywhere** (team decision, 2026-11-21; supersedes the original "AI for extraction and GL codes").
  Extraction is OCR plus deterministic parsing, and confidence is calculated from cross-checks. GL coding is a
  frequency count over `invoice_lines.csv` plus nearest past line description. Reasons: auditable, same
  output every run, bank details never leave our machines, no per-invoice cost, and the dataset's OCR traps
  (Prairie scan) only show up with real OCR. A benchmark against a local vision model is a possible bonus.
- **Everything else is deterministic code:** duplicate checks, tax and arithmetic checks, PO and contract matching, approval routing, permissions. These must be explainable line by line in the Q&A and must give the same result every time.
- **Every check returns a reason**, e.g. `{ code: "FUEL_SURCHARGE_OVER_CAP", severity: "block", message: "Fuel surcharge 22% exceeds contract C018 cap of 12%" }`. The UI shows these reasons as plain language. Never show a bare "flagged".
- **Severities:** `block` (can't proceed), `warn` (needs a human acknowledgement), `info`.
- **One audit table**, append-only: `actor_user_id`, `on_behalf_of_user_id` (for delegation), `action`, `entity_type`, `entity_id`, `before`, `after`, `reason`, `timestamp`. Every API mutation writes to it.
- **Check permissions in one place** (a single `can(user, action, resource)` function), not scattered across routes.
- **Money:** store amounts in integer cents or as decimals, **never floats**. Round tax to 2 decimals.
- **Dates:** treat **2026-11-02** as "today" (configurable). Invoice dates after that are future-dated.
- **Login for the demo:** a user switcher (pick any of the 40 users) is fine. Don't build real auth.

---

## Acceptance tests: traps planted in the data

The app must catch each of these. See `TRAP_MAP.md` (copied from the project doc) for the full list. Turn them into automated tests where you can.

**Fraud and vendors**
- Cascadia Cartage (V004): bank changed 2026-10-27 **by email, not verified** (BC-009). Invoices 1624 (`scan_8049.png`) and 1625 pay to the new account → hold.
- "Harlow **and** Stern LLP" (V052) is a look-alike of Harlow & Stern LLP (V026), with a different domain, GST number and bank. Invoice HA26-2766 → block.
- Great Lakes Carriers Incorporated (V053) duplicates V002.
- Blue Heron Couriers and Zephyr Data are not in the vendor master.
- Riverbend Catering (V054) is `pending_review`.

**Duplicates**
- Polar 000961 (= AP-00393), Harlow & Stern 001468 (= AP-00389), Cloudbarn INV-01561 (= AP-00370, paid by card), Voyageur 000903-A (= AP-00277), Brightline 583 (= AP-00330 #FA-000583).
- In the history: AP-00394 and AP-00407 are both scheduled for the same invoice, so it's **about to be paid twice**. Several invoices were already paid twice, or paid by EFT and also on an employee card. That's about **$23.6k** overpaid.

**Math, tax and contracts**
- Evergreen 000850: the total is $100 off.
- Northstar NO26-1773: 24 × $150 ≠ $3,800.
- Polar 000964: 22% fuel surcharge vs the 12% cap.
- Northbound 000639: HST charged on an AB delivery.
- Ironwood INV-02210: no tax on ON goods.
- Beaumont FA-000557: no QST on a QC delivery.
- Signal & Sparrow 000970: PST charged on services.
- Aurora AU26-2207 and Pinecone PI26-2809: billed over the fixed contract fee.
- Summit 000809: future-dated.
- Torque 1771: contract expired and over the PO balance.

**Approvals**
- Orion 279, 281 and 287 on the same day add up to about $14.5k: a split to stay under $10k.
- In the history: self-approvals by U010 (AP-00092, AP-00178, AP-00235).
- Liam O'Connor (U012) is on leave and his delegate is the finance manager (U003). On a Facilities invoice over $10k (Queen Street rent 002935, $18,758), U003 can't fill both steps and can't release the payment.

**PO matching**
- No incoming invoice prints a PO number. Match each one to the vendor's open PO.
- Hardhat 853 and Brightline 583 have **no open PO**, so they're held.

**Inbox**
- EM-059 is a newsletter and EM-056 is a statement: don't create invoices.
- EM-058 is missing its attachment.
- EM-057 asks about invoice 1743, which was already paid (PAY-00047, 2026-03-09).
- EM-029 contains two invoices.

**Credit notes**
- Fixwell CN-FA-000413 and Great Lakes CN-GR26-2274 should be applied against the next payment to that vendor, not paid out.

---

## Our differentiators (only once the core works)

1. **"Try to Fool Us" mode.** Judges forge an invoice or a bank change live, and the app catches it.
2. **Bank-change callback.** Hold payments and make someone call the **phone number on file before the change**. Log who called and the outcome.
3. **Overpayment recovery.** "You paid $23.6k twice this year." Show it as a list of what to claw back.
4. **Lost tax-credit alert.** Flag invoices missing GST/QST numbers or charging tax wrongly, with the dollar amount at risk.
5. **"Where's my money?" auto-reply.** Detect payment-status emails and draft a reply from the payment record.

Brim-specific bonuses worth doing: single-use virtual card payments, and "already paid by card" detection.

---

## Conventions

- Keep files small and named after what they do (`checks/duplicates.py`, `checks/tax.py`, `workflow/routing.py`).
- Each check is a pure function: `check_x(ctx) -> list[CheckResult]` (all SQL happens once, in `checks/context.py`). That makes it easy to unit test against the trap list above.
- Don't hardcode vendor IDs or invoice numbers in app logic. Hardcode them only in tests and demo scripts.
- Commit often with clear messages. Don't commit `.env` or API keys.
- If a requirement is ambiguous, pick the simplest reasonable reading, leave a `// DECISION:` comment explaining it, and add it to the list below so we can explain it to the judges.

### UI rules (a calm, keyboard-first finance tool; started from Wealthsimple's simplicity)

The look lives in `frontend/src/styles.css` (tokens: colour, a 7-step type scale, the 4/8/12/16/24/32/48 spacing
scale, radius, motion, one shadow), `frontend/src/theme.ts` (Ant Design restyled to the same values) and
`frontend/src/components/ui.tsx` (Page, PageTitle, Hero, Section, Panel, Stat, Money, Pill, StatusPill, Row,
Avatar, EntityHead, Notice, Check, Tiles, Chips, ActionButton, Progress, Skeleton, Kbd, EmptyState, Draft, Cards)
plus `components/DataTable.tsx`. Build every screen from those pieces; if something is missing, add it there.
Inline styles only for values computed at runtime (an avatar's colour, a progress width).

- **Layout:** left sidebar with work-count badges (a bottom tab bar on phones), a main column, and a sticky right
  panel (`<Page rail={…}>`) for "what to do next". Detail pages pass `head` (who/what + the big number) so on a
  phone the order is head → panel → details.
- **One big number per screen** (`Hero`), in words a non-accountant understands: "Paid to vendors this year".
  Home's chart is a running total; the big number follows the cursor.
- **One primary action per screen**, in the right panel: a black pill (`type="primary" shape="round"`).
  Secondary actions are soft grey pills (`className="soft"`), destructive ones soft red (`"danger-soft"`). Use
  `ActionButton`: a pending state while it runs, and when not allowed it stays visible, disabled, with the server's
  reason under it. Toasts say what happened and link to it when it happened elsewhere.
- **Work queues are DataTables** (Inbox to review / on hold, Payments, Bank, Vendors, Approvals, findings, audit
  log): sticky header, whole row clickable, j/k or arrows + Enter, skeleton while loading, a designed empty state.
  Short columns have fixed widths; columns drop by the table's own width (container queries). **Home and side
  panels keep `Row` lists**: logo, name, one line of context, amount on the right.
- **Status = a dot + a word, everywhere** (`Pill` / `StatusPill`), one vocabulary in `format.ts`: Needs review,
  On hold, Waiting for approval, Approved, Scheduled, Paid, Rejected. Amber = a person must act, red = blocked,
  blue = in flow, green = done, grey = nothing to do. Never colour alone.
- **Plain language, never codes**: "Waiting for Elise", not `pending_approval`. Checks are their sentence.
- **Money** arrives as integer cents and is shown with `Money` (tabular digits, CAD/USD always written, credits
  with a minus) or `money()` in sentences. The browser never adds, subtracts or rounds money: totals come from the
  API.
- **One font**, Inter Tight (bundled, works offline). Few captions. Body text ≥ 15px.
- **Accessible**: visible focus rings, everything reachable by keyboard, aria labels on icon-only controls, AA
  contrast (the darkest grey we put text on is `--ink-3`, 4.5:1 on grey), motion off under reduced-motion.
- Checked at 1280×720 with 125% zoom (= 1024×576) and at 390px: `node e2e/overflow.mjs`.

### Decisions log

- **PO balance compared on the total including tax.** P12's text says "total", and the trap map's expected
  results only hold this way (Summit 000809: $5,000 pre-tax fits its $5,500 PO, $5,748.75 with tax does not).
  Historical POs are inconsistent (most equal the pre-tax subtotal), so the data doesn't settle it.
  Pre-tax is common practice because tax is recoverable; be ready to defend the choice.
- **Duplicate matching key:** same vendor (or a flagged look-alike vendor) + normalized invoice number
  (uppercase, keep digits, drop leading zeros and suffixes like `-A`: `FA-000583` → `583`) = block.
  Same vendor + same total within 14 days with a different number = warn (see "Duplicate windows" below).
  Matching employee-card charge = block.
- **Delegate conflict handling:** if the on-leave approver's delegate would also fill a later step, the
  delegated step escalates to the on-leave approver's own manager instead. Queen Street 002935: step 1 →
  U001 (Liam's manager), step 2 → U003 (finance manager), release → U002. Rejected alternative: U003 does
  step 1 and step 2 escalates to U002, which leaves only the CFO able to release.
- **Release when the finance manager is conflicted (P11):** any `controller_admin` who did not approve the
  invoice may release, since a controller outranks the finance manager.
- **"Today" is 2026-11-02**, set by `AP_TODAY`. Audit timestamps use the real clock (when it happened).
- **Policy thresholds are data:** dollar amounts are parsed from `approval_policies.condition` at seed time
  into `threshold_cents`, and routing reads them from there. That's what "configurable" means here.
- **Requester and department of incoming invoices** (they print neither): department comes from the GL coding
  suggestion; requester is the matched PO's requester, else the vendor's most frequent past requester.
  Both are editable before submitting for approval.
- **Credit notes** are stored as negative invoices, never paid out, and netted against the vendor's next payment.
- **History stays live:** the 18 historical `scheduled` payments appear on the payments dashboard, so the
  AP-00394/AP-00407 double payment is caught there.
- **Uploaded files are stored in Postgres** (all under 1 MB), so a worker on another machine needs only a
  database connection.
- **Keystone KE26-1198 is flagged over its PO**, although TRAP_MAP says "within". PO-0046 is $6,803.89; the invoice is
  $6,185.35 before tax and $6,989.45 with 13% HST. TRAP_MAP's own "over with tax" results for Summit and Alpenglow
  only hold with tax included, so it can't be consistent either way. We apply tax-included everywhere. Over the PO
  is a *warning* that adds a finance manager step (P12), not a block.
- **OCR runs 3 Tesseract passes** (page modes 3, 4, 6) and votes per field, preferring well-formed values. If the
  passes disagree, the field gets low confidence and the invoice goes to a person, with the readings shown
  (Prairie: "$5541", "$5541", "55541"). Text-layer PDFs skip OCR entirely.
- **Confidence is calculated:** text layer 0.99, OCR agreeing 0.90, disagreeing 0.60, malformed 0.40, missing 0.
  Any field under 0.80 sends the invoice to review.
- **Touchless:** a brand-new invoice with no blocks, no warnings and no doubtful field goes straight to approval.
  Anything a person looked at moves on only when they click Submit, which records them as reviewer.
- **Look-alike vendor** = a vendor whose name is ≥85% similar to one we have *paid*, with a different GST number and
  bank account. Onboarding dates can't be used: the impostor V052 has an older onboarding date than the real V026.
  **Duplicate vendor record** = similar name plus the same GST, bank account or email (V053/V002, V051/V001); their
  invoices are compared together for duplicates.
- **Duplicate windows:** same vendor + same amount + different number within **14 days** is a warning (30 days
  flagged every monthly subscription). An employee-card charge from the vendor for the same amount within 30 days
  means it was already paid by card. Brim virtual-card payments belong to a specific invoice (memo), so a re-sent
  invoice is caught by its number instead.
- **Split invoices:** same vendor, within 4 days, each ≤ $10k, together > $10k. Warning, plus a finance manager step.
- **Stale invoice:** older than 120 days. Warning.
- **Double payments in the history:** several payments of ONE invoice that add up to its total are instalments,
  not double payments. Card charges are compared with the invoice total, because AP may have paid less with an
  early-payment discount (Paper Trail). Result: $23,601.92 overpaid.
- **A printed account that is the vendor's previous, verified-and-replaced account** is info, not a block: payment
  always goes to the account on file. An account we've never had on file blocks.
- **Four-eyes everywhere money or trust changes:** whoever prepared a payment can't release it; whoever onboarded a
  vendor can't approve it; whoever entered a bank change can't verify it by callback. (Extends P11's idea.)
- **Bank change rejected by the vendor on callback:** for a change already written to the vendor record (like BC-009),
  the vendor is put on hold, since the account on file may be a fraudster's.
- **Payment date:** the due date, or today if already due. **Settlement is a button** ("Record bank confirmation")
  because there's no real bank. A virtual-card payment also writes a card transaction, like the history does.
- **Credit notes** need the normal approval (department manager), then are deducted automatically, oldest first,
  from the next payment to that vendor in the same currency. Stopping that payment makes the credit available again.
- **Requester suggestion skips people who've left** (U015 is terminated).
- **Tax at risk** = tax we'd pay and can't claim back: HST charged above the correct GST, BC PST on services (never
  recoverable), a tax that doesn't apply, GST/HST without the vendor's GST number, QST without a QST number (Revenu
  Québec needs it). Tax *missing* from an invoice isn't counted: nothing was paid. Invoices we won't pay anyway
  (rejected, duplicates, paid by card) are left out. Each check stores `at_risk_cents` and the fix.
- **QST charged with no QST number** (printed or on file) is a warning. The dataset's BC/MB vendors bill QC
  deliveries this way; all 5 were already held or in review for other reasons, so no routing changes.
- **Replies are drafted, never sent.** The app writes the answer from our records (payment, invoice, status) with
  string templates; AP sends it from their own mailbox and clicks *Mark as answered* (audited, with who and when).
- **Getting double payments back:** each double payment already made is *to recover* → *refund requested* →
  *recovered*, keyed by its payment ids. Scheduled-twice payments aren't recoveries: you stop one on Payments.
- **Try to fool us** builds fake PDFs from real vendor master data (a 40-line hand-written PDF, no library) and
  drops them into the normal queue. The page never decides "caught" itself: a fake counts as caught if any block or
  warning fired, or it's on hold, in review or rejected. Every upload counts as an attempt; the split trick's two
  invoices count once. Vendor ids are hard-coded only there (`app/demo/`), as a demo script.
- **A file we can't read** (blank image, damaged PDF) fails with a plain sentence and isn't retried; other worker
  errors are retried up to 3 times.
- **Single-use virtual card:** one card per card payment, issued at release (so P09–P11 still decide who sends money),
  locked to the vendor, the **exact** amount and one charge, valid 30 days, sent to the vendor's AP email, last 4
  digits only stored. A smaller charge is declined too: it would close the single-use card with the invoice part-paid.
  The card settles the payment; there is no "bank confirmation" button for it. Every attempt is kept with its reason
  (`card_authorizations`), answering the reviews' top card complaint: "blocked for fraud" and nobody says why.
  "Charge the card" stands in for the card network (permission `card.record_charge`, AP or finance).
- **An unverified bank change also holds card payments:** the card is sent by email, and the bank change came by email.
- **AP picks the payment method** when preparing (defaults to the vendor's preferred one).
- **Bank statement check** (`reconcile.py`, from Brim's reviews: fees nobody explains, payments "not received"):
  EFT lines match by the 6-digit trace = last 6 digits of our reference; cleared cheques match an issued cheque of
  the same amount, oldest first; no exact match but an uncashed cheque within $1 = the same cheque cleared for a
  different amount (altered cheque: cheque 5018, +$0.05). Monthly account fees get booked to the bank-fees GL
  (found by name, 7010); wire fees (we never send wires) and pre-authorized debits nobody set up go to the bank in
  one drafted email. Only the extra amount counts as unexplained when a payment cleared for more than we sent.
  Asking the bank isn't getting the money back: those debits stay "in question" until answered. A payment settled
  in the last 3 days may still be in transit, so it isn't flagged as missing from the statement.
- **Signed audit chain** (`audit_chain.py`): each event stores `hash = HMAC-SHA256(AUDIT_KEY, prev_hash ||
  canonical JSON of the event)`. The trigger stops edits; the chain makes an edit made with the trigger switched off
  *detectable*, down to the event (`make tamper` shows it). **HMAC, not a plain hash:** with a plain hash, whoever can
  edit the table can recompute every hash after their edit. **Advisory lock** (`pg_advisory_xact_lock`) before
  reading the last hash: two concurrent transactions would otherwise fork the chain; ids are taken under the lock so
  event_id order is chain order. Rejected: a "notary" process signing after commit (no waiting, but events are
  briefly unsigned). Production: the key in a KMS, and the head hash copied outside the database regularly, so
  deleting the newest events (which leaves no broken link) is caught too. Verifying is for the auditor and
  controllers (it's read-only, so the auditor may run it).
- **Worker visibility timeout:** a job left `running` for more than 5 minutes (its worker died) is claimed again by
  another worker; after 3 abandons it fails with a plain sentence. Reading a document takes 1–5 s. Rejected: worker
  heartbeats (more moving parts than this scale needs).
- **Where each field was read** (`extraction/sources.py`), found AFTER the parser, never changing it: words with
  their boxes from `pdftotext -bbox` (text PDFs) or one extra Tesseract TSV pass in the page mode whose reading
  we kept (scans), grouped into visual rows; amounts matched by value with the parser's own AMOUNT pattern, on the
  row with the right label (the LAST "Total" row, not the subtotal); codes and dates by exact characters on their
  labelled row. **A value we can't find gets no box** (a wrong box teaches people to trust the wrong number);
  every printed field is found on all 56 incoming documents, the Prairie scan's tax line is the one honest gap.
  Boxes are fractions of the page (0–1), so they fit any rendering. Page images: page 1 at 150 dpi, cached on disk
  by the file's sha256; scans are served exactly as received. If locating fails, the invoice is still read.
- **Every total comes from the API** (T3 found the browser adding amounts on Payments, Approvals, Bank, Activity,
  Home's chart and a vendor's PO balance): `/payments` returns per-tab totals, `/approvals/mine` a total, `/home`
  the running total and range changes, `/bank` per-task totals, `/findings` recovery and tax totals, vendor POs
  `remaining_cents`. The only arithmetic left in the browser is the width of a progress bar.
- **The Home hero counts up once** (< 600 ms) from 0 to the API's number; the frames are animation only and the
  number that stays is the server's. Off under prefers-reduced-motion.
- **CAD/USD always written** (`$3,716.34 CAD`), even in a CAD-only company: it costs four characters and removes
  every doubt about a number on a projector. Rejected: showing the code only for USD (inconsistent).
- **Tables vs lists:** work queues became tables (scan columns, keyboard), Home and side panels stayed lists
  (Wealthsimple feel). Columns hide by the table's width, not the window's: the same table sits in a 600px laptop
  column and on a phone.
- **Invoice page layout:** the real document on the left (sticky, zoomable), the one next action top right, then the
  checks, "What we read", details, lines and the invoice's life. Below 1180px it stacks: next action → document → rest.
  Rejected: a "Document" tab (it hides the evidence behind a click, and the reviewer's job is comparing the two).
- **Where-we-read-it boxes** are drawn over the page image as % of the page; hovering a field lights its box and the
  other way round. Dashed box = read by OCR. A field with no box simply has none (see "Where each field was read").
- **Picking an OCR reading** ("Use “$5541”") is the normal audited edit (PATCH, reason "Picked the OCR reading …"),
  and the checks re-run: a wrong pick is caught by the bank-account check like any other. Every distinct reading is
  offered, malformed ones too, because the person has the paper in front of them. After a person sets a field, its
  "please confirm" note becomes "Set by <name>".
- **Pipeline strip and Life of this invoice** are built in the browser from what the invoice page already gets
  (invoice, email, extraction, approvals, payments, audit events, bank line): no money is computed, only words.
  Rejected: a /pipeline endpoint returning the same facts a second time.
- **Bank statement line on the invoice page:** only bank transfers and cheques are looked for (card payments go through
  the card account). Settled in the last 3 days and not on the statement = "In transit", as on the Bank page.
- **Keyboard on the invoice page:** A approve, D decline, P pay (prepare, or release), E correct, [ ] previous/next,
  ? the list. Single keys, ignored while typing or in a dialog. A refused key shows the server's reason, the same
  sentence a disabled button shows. [ and ] walk the list the invoice was opened from: the DataTable stores that list
  in sessionStorage (this tab only). Rejected: a server "next invoice" endpoint (it would have to know which list and
  filter you came from).
- **Times are written "7:19 PM"** everywhere (en-US style), so a page never mixes "PM" and "p.m.".
- **Cmd+K search** (`app/search.py`): every typed word must match something on the row, and each kind of match is
  worth points (AP id 100, invoice number 90, amount 70, part of the number 60, vendor name 40), so "orion 279" puts
  Orion's 279 first. Numbers compare like the duplicate check (`583` finds `FA-000583`); "6452" means $6,452.00 to
  $6,452.99, "$6,452.30" exactly that. The ~500 invoices are scored in Python: instant at 50 invoices a month, and the
  rules read as code. Rejected: Postgres full-text search (it doesn't understand invoice numbers or amounts); at scale,
  a pg_trgm index. Vendors are listed first, with the same look-alike warning as the vendor page.
- **The palette itself** is in-house (`CommandPalette.tsx`, a text box and a list, the combobox ARIA pattern) inside
  the AntD modal, which gives the focus trap and Esc. Rejected: a palette library (one more dependency to explain).
  People, pages and actions are matched in the browser (already loaded); "as elise" lists only people, and picking
  one is the same demo login as the user picker. Refused actions show the server's reason.
- **Recent items** (last 6 invoices and vendors opened) are kept in localStorage: per browser, a convenience only.
- **Show the math** (`app/breakdowns.py`): hover or focus an important amount (invoice total, subtotal, each tax, a
  line, the PO balance, a payment with credit notes deducted, Home's hero and "money to get back", the Bank hero,
  Activity's heroes, a vendor's PO) to see its parts. Built on the server with the checks' own helpers (apply_rate, the
  PO balance from `checks/context.py`), so a tooltip can't disagree with a check. **The parts always add up:** a printed
  number that doesn't is shown with its gap as a part ("Not explained by the subtotal and tax: $100.00" on Evergreen,
  "24 × $150.00 = $3,600.00 + not explained $200.00" on Northstar). Rejected: showing only the check's sentence (you
  can't see where the number comes from) or doing the sum in the browser (never money math there).
- **Inside a link** (Home's rows, payment rows) the breakdown shows on hover only: a second focus stop inside a link is
  invalid HTML. The page the link opens has the same number, reachable by keyboard.
- **Lists aren't broken down again:** a total sitting right above its rows (Payments tabs, the Bank page's to-do totals)
  gets no tooltip; the rows are its breakdown.
- **The tax line is labelled with the tax actually charged** (Northbound charges HST on an Alberta delivery: "HST"),
  not the one the province expects. The check says it's wrong; the label says what's printed.
