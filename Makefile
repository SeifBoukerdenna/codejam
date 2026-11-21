.PHONY: up down reseed test traps psql

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
