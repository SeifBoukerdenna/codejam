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
from app.extraction.text import Unreadable
from app.pipeline import process_document

MAX_ATTEMPTS = 3
IDLE_SLEEP_SECONDS = 1.0
# DECISION: a "visibility timeout", like a cloud queue's. A worker that dies mid-document (killed, machine off)
# never marks its job done; after this long another worker may take it again. Reading a document takes 1–5 s,
# so 5 minutes is far longer than any real job. Rejected: worker heartbeats (more moving parts for this scale).
STALE_AFTER_SECONDS = 300


def claim(url: str | None, worker_id: str) -> dict | None:
    """Take the next job: a queued one, or one whose worker stopped answering (claimed too long ago)."""
    with db.transaction(url) as conn:
        # A job that has already been abandoned MAX_ATTEMPTS times is given up on, in plain words.
        for stuck in conn.execute(
                """UPDATE extraction_jobs SET status = 'failed', finished_at = now(),
                          error = 'The worker reading this file stopped responding 3 times. Upload it again.'
                   WHERE status = 'running' AND attempts >= %s AND claimed_at < now() - make_interval(secs => %s)
                   RETURNING job_id, document_id""", (MAX_ATTEMPTS, STALE_AFTER_SECONDS)).fetchall():
            audit.log(conn, actor=None, action="document.read_failed", entity_type="document",
                      entity_id=str(stuck["document_id"]), reason="Abandoned by its worker 3 times")
        return conn.execute(
            """UPDATE extraction_jobs SET status = 'running', worker_id = %s, claimed_at = now(), attempts = attempts + 1
               WHERE job_id = (SELECT job_id FROM extraction_jobs
                               WHERE status = 'queued'
                                  OR (status = 'running' AND claimed_at < now() - make_interval(secs => %s))
                               ORDER BY job_id FOR UPDATE SKIP LOCKED LIMIT 1)
               RETURNING *""", (worker_id, STALE_AFTER_SECONDS)).fetchone()


def run_job(url: str | None, job: dict) -> None:
    try:
        with db.transaction(url) as conn:   # the whole document -> invoice step commits, or none of it does
            invoice_id = process_document(conn, job["document_id"])
            # clock_timestamp(), not now(): now() is when this transaction BEGAN, i.e. before the document was read,
            # which made every read look instant. The health page's read-time SLO (health.py) depends on this.
            conn.execute("UPDATE extraction_jobs SET status = 'done', finished_at = clock_timestamp(), error = NULL "
                         "WHERE job_id = %s", (job["job_id"],))
        print(f"job {job['job_id']}: document {job['document_id']} -> {invoice_id}", flush=True)
    except Exception as exc:  # noqa: BLE001 - any failure goes back on the queue, with the reason recorded
        # A file that can't be read fails the same way every time, so it isn't retried. Anything else
        # (database blip, worker killed) goes back on the queue up to MAX_ATTEMPTS times.
        unreadable = isinstance(exc, Unreadable)
        status = "failed" if unreadable or job["attempts"] >= MAX_ATTEMPTS else "queued"
        error = str(exc) if unreadable else f"{type(exc).__name__}: {str(exc).splitlines()[0]}"
        with db.transaction(url) as conn:
            conn.execute("UPDATE extraction_jobs SET status = %s, error = %s, finished_at = clock_timestamp() WHERE job_id = %s",
                         (status, error, job["job_id"]))
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
