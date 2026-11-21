"""Database access: plain SQL through psycopg 3, rows returned as dicts.

No ORM on purpose: every query the app runs is visible in the code, which is easier to explain than an
ORM's generated SQL.
"""

from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row

from app import config


def connect(url: str | None = None) -> psycopg.Connection:
    return psycopg.connect(url or config.DATABASE_URL, row_factory=dict_row)


@contextmanager
def transaction(url: str | None = None):
    """Open a connection, run the block in one transaction, commit on success, roll back on error."""
    with connect(url) as conn:
        with conn.transaction():
            yield conn


def get_conn():
    """FastAPI dependency: one connection per request.

    Endpoints that change data wrap their work in `with conn.transaction():` so the commit happens inside
    the handler, before the response is sent. Relying on this dependency's cleanup to commit would mean a
    failed commit could never turn into an error response.
    """
    with connect() as conn:
        yield conn
