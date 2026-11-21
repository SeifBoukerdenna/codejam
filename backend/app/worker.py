"""Extraction worker: takes documents off the queue and turns them into invoices.

    python -m app.worker          run forever (docker compose starts one)
    python -m app.worker --drain  process what's queued, then exit

Workers coordinate through Postgres only: a job is claimed with SELECT ... FOR UPDATE SKIP LOCKED, so any
number of workers, on this machine or others (just point DATABASE_URL here), never take the same job.
OCR is CPU-heavy; running it here keeps the API responsive while documents are being read.
"""

import argparse
import os
import socket
import time

from app import audit, db
from app.pipeline import process_document

MAX_ATTEMPTS = 3
IDLE_SLEEP_SECONDS = 1.0


def claim(url: str | None, worker_id: str) -> dict | None:
    with db.transaction(url) as conn:
        return conn.execute(
            """UPDATE extraction_jobs SET status = 'running', worker_id = %s, claimed_at = now(), attempts = attempts + 1
               WHERE job_id = (SELECT job_id FROM extraction_jobs WHERE status = 'queued'
                               ORDER BY job_id FOR UPDATE SKIP LOCKED LIMIT 1)
               RETURNING *""", (worker_id,)).fetchone()


def run_job(url: str | None, job: dict) -> None:
    try:
        with db.transaction(url) as conn:   # the whole document -> invoice step commits, or none of it does
            invoice_id = process_document(conn, job["document_id"])
            conn.execute("UPDATE extraction_jobs SET status = 'done', finished_at = now(), error = NULL WHERE job_id = %s",
                         (job["job_id"],))
        print(f"job {job['job_id']}: document {job['document_id']} -> {invoice_id}", flush=True)
    except Exception as exc:  # noqa: BLE001 - any failure goes back on the queue, with the reason recorded
        status = "failed" if job["attempts"] >= MAX_ATTEMPTS else "queued"
        with db.transaction(url) as conn:
            conn.execute("UPDATE extraction_jobs SET status = %s, error = %s, finished_at = now() WHERE job_id = %s",
                         (status, f"{type(exc).__name__}: {str(exc).splitlines()[0]}", job["job_id"]))
            audit.log(conn, actor=None, action="document.read_failed", entity_type="document",
                      entity_id=str(job["document_id"]), reason=f"{type(exc).__name__}: {exc} (attempt {job['attempts']})")
        print(f"job {job['job_id']} failed ({status}): {str(exc).splitlines()[0]}", flush=True)


def drain(url: str | None = None, worker_id: str = "inline") -> int:
    done = 0
    while (job := claim(url, worker_id)) is not None:
        run_job(url, job)
        done += 1
    return done


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--drain", action="store_true", help="process the queue once, then exit")
    args = parser.parse_args()
    worker_id = f"{socket.gethostname()}:{os.getpid()}"
    if args.drain:
        print(f"processed {drain(worker_id=worker_id)} documents")
        return
    print(f"worker {worker_id} waiting for documents", flush=True)
    while True:
        if drain(worker_id=worker_id) == 0:
            time.sleep(IDLE_SLEEP_SECONDS)


if __name__ == "__main__":
    main()
