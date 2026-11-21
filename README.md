# Harborline AP

Supplier invoice to payment for Harborline Logistics: intake → read → code → check → approve → pay, with
every step audited. CodeJam 16, Brim Financial challenge. Payments are simulated.

Project brief, business rules and the decisions log: [CLAUDE.md](CLAUDE.md). Planted traps: [TRAP_MAP.md](TRAP_MAP.md).
Diagrams (open at excalidraw.com → File → Open, or with the VS Code Excalidraw extension):
- [docs/architecture.excalidraw](docs/architecture.excalidraw): the containers, what flows between them, and how each part works
- [docs/action-flows.excalidraw](docs/action-flows.excalidraw): every action end to end (who, needs, request, permission,
  server logic, tables, audit) plus the tech underneath and everything needed to run it

## Run it

Needs Docker (Docker Desktop on macOS/Windows).

```sh
make up        # db + api + web; seeds the database on first start
```

- UI: http://localhost:5173 (pick a user in the top-right switcher, or open a link with `?as=U003`)
- API docs: http://localhost:8000/docs

| Command       | What it does |
|---------------|--------------|
| `make up`     | Start everything |
| `make down`   | Stop (data is kept) |
| `make reseed` | Wipe the database and reload the dataset |
| `make test`   | Backend tests, on a separate `ap_test` database |
| `make traps`  | TRAP_MAP checklist: one line per trap, CAUGHT or MISSED |
| `make psql`   | SQL prompt |

No `make`? Each target is one `docker compose` command; see the [Makefile](Makefile).

## Demo in 2 minutes

1. Open http://localhost:5173/?as=U004 (Jordan, AP clerk) → **Inbox** → **Sort 59 new emails**. The worker reads the
   56 documents (about 5 seconds); invoices land in *To review*, *On hold* or go straight to approval.
2. Open an invoice: the checks explain themselves in plain words, *What we read* shows confidence per field.
3. Switch user (top right) to the approver named on the invoice → **Approve**. Then Jordan → **Pay**.
4. Try to release as the person who approved it: refused, with the reason (P11). Release as the controller (U002).
5. **Activity → Paid twice**: $23,601.92 paid twice this year. Open one: the refund request is written from the
   payment records; mark it requested, then recovered. **Tax at risk** shows the tax we couldn't claim back.
6. **Inbox → To answer**: the "where's my payment?" email (EM-057) has a reply drafted from PAY-00047. Copy it or
   open it in your mail app, then **Mark as answered**.
7. **Try to fool us**: click any trick (bank account swap, look-alike vendor, reused number, wrong tax…). A fake PDF
   goes through the same worker and checks as a real invoice, and the card says what caught it. Judges can download
   a clean invoice from the right panel, edit it, and upload it.

8. **Pay by virtual card**: on an approved invoice (e.g. AP-00425, Northbound) pick *Virtual card* → Pay; release as
   Elise (U003). The single-use card appears; charge it 3% too much (declined, with the reason), then the exact
   amount (paid), then again (declined: single use).
9. **Bank**: every debit on the statement matched or explained. $1,523.09 can't be: pre-authorized debits nobody
   set up, wire fees for wires we never sent, a cheque that cleared 5 cents over what we wrote. **Write to the bank**
   drafts the email; book the fees; mark the 19 cashed cheques.

`make reseed` puts everything back to the start.

## Running more OCR workers (or one on another machine)

Workers only need a database connection: they claim documents with `SELECT … FOR UPDATE SKIP LOCKED`.

```sh
docker compose up --scale worker=3                 # more workers on this machine
```

On another machine (e.g. a faster laptop): change the db port in `docker-compose.yml` to `"5432:5432"` (trusted
network only), then on that machine `brew install tesseract tesseract-lang poppler`, `pip install -r backend/requirements.txt`, and
`cd backend && DATABASE_URL=postgresql://ap:ap@<host>:5432/ap python -m app.worker`.

## Layout

```
backend/app/schema.sql   every table, with comments on why it looks that way
backend/app/seed.py      loads every CSV + inbox/emails.json
backend/app/intake.py    sorts the inbox, stores documents, queues them
backend/app/worker.py    the extraction worker (queue, retries)
backend/app/extraction/  text layer / OCR, the bilingual parser, confidence
backend/app/coding.py    GL account + department suggestions with reasons
backend/app/checks/      one file per kind of check; run.py lists them all
backend/app/workflow/    approval routing (P01–P08), approvals, payments (P09–P11)
backend/app/auth.py      can(): every permission decision
backend/app/findings.py  audit findings over the history
backend/app/main.py      HTTP API entry point; one router per area in backend/app/routes/
backend/tests/           pytest, incl. the trap checklist
frontend/src/pages/      one file per screen (Home, Inbox, Approvals, Payments, Vendors, Activity, details)
frontend/src/components/ shared building blocks (ui.tsx) and the app shell
frontend/src/styles.css  the design system; UI rules are in CLAUDE.md
data/brim_ap_dataset/    the dataset (CSVs, inbox, incoming invoices)
```
