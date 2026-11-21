# Harborline AP

Supplier invoice to payment for Harborline Logistics: intake → read → code → check → approve → pay, with
every step audited. CodeJam 16, Brim Financial challenge. Payments are simulated.

Project brief, business rules and the decisions log: [CLAUDE.md](CLAUDE.md). Planted traps: [TRAP_MAP.md](TRAP_MAP.md).

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
| `make traps`  | TRAP_MAP checklist: caught / missed (step 4) |
| `make psql`   | SQL prompt |

No `make`? Each target is one `docker compose` command; see the [Makefile](Makefile).

## Layout

```
backend/app/schema.sql   every table, with comments on why it looks that way
backend/app/seed.py      loads every CSV + inbox/emails.json
backend/app/main.py      HTTP API entry point; one router per area in backend/app/routes/
backend/tests/           pytest, incl. the trap checklist
frontend/src/pages/      one file per screen (Home, Inbox, Approvals, Payments, Vendors, Activity, details)
frontend/src/components/ shared building blocks (ui.tsx) and the app shell
frontend/src/styles.css  the design system; UI rules are in CLAUDE.md
data/brim_ap_dataset/    the dataset (CSVs, inbox, incoming invoices)
```
