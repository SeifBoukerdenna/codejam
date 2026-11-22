.PHONY: up down reseed test traps psql tamper verify-audit demo-test demo-video

up:      ## Start db + api + worker + web. UI on http://localhost:5173, API on http://localhost:8000/docs
	docker compose up --build

down:    ## Stop everything (data is kept in the pgdata volume)
	docker compose down

reseed:  ## Wipe the database and reload the dataset from the CSVs
	docker compose run --rm api python -m app.seed

test:    ## All backend tests (they use their own ap_test database)
	docker compose run --rm api pytest

traps:   ## Trap checklist from TRAP_MAP.md: one line per trap, CAUGHT or MISSED
	docker compose run --rm api pytest tests/test_traps.py -q

psql:    ## SQL prompt on the app database
	docker compose exec db psql -U ap ap

tamper:  ## Q&A demo: as the DB superuser, bypass the append-only trigger, rewrite one approval, then verify
	docker compose run --rm api python -m app.demo.tamper

verify-audit:  ## Re-check every signature in the audit chain
	docker compose run --rm api python -c "from app import audit_chain, db; print(audit_chain.verify(db.connect()))"

demo-test:  ## The 3:30 demo as a test in Chrome (e2e/demo.mjs): reseed, every step clicked and checked, then reseed again
	node e2e/demo.mjs; status=$$?; $(MAKE) -s reseed >/dev/null; exit $$status

demo-video: ## The same demo at human pace, recorded to docs/demo-run.webm (needs ffmpeg), then reseed again
	RECORD=docs/demo-run.webm node e2e/demo.mjs; status=$$?; $(MAKE) -s reseed >/dev/null; exit $$status
