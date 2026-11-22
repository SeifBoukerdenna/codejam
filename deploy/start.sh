#!/bin/sh
# Seed on the first boot only, run the worker beside the API, restart it if it exits (as Docker Compose does).
set -e
python -m app.seed --if-empty
( while true; do python -m app.worker || true; sleep 3; done ) &
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-10000}"
