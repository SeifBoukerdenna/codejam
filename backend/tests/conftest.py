"""Tests run against their own database (ap_test on the same Postgres server), freshly seeded once per test
session, so they never touch the data you are demoing with and always start from the same state."""

import os

import psycopg
import pytest
from fastapi.testclient import TestClient

from app import config, db, intake, seed, worker
from app.db import get_conn
from app.main import app


def _database(name: str) -> str:
    """URL of a scratch database on the same server, created if needed and freshly seeded."""
    server_url = config.DATABASE_URL.rsplit("/", 1)[0]
    # CREATE DATABASE cannot run inside a transaction, hence autocommit on the maintenance database.
    with psycopg.connect(server_url + "/postgres", autocommit=True) as admin:
        if not admin.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone():
            admin.execute(f'CREATE DATABASE "{name}"')
    url = f"{server_url}/{name}"
    seed.seed(url)
    return url


@pytest.fixture(scope="session")
def db_url() -> str:
    """The dataset exactly as seeded."""
    return os.environ.get("TEST_DATABASE_URL") or _database("ap_test")


@pytest.fixture(scope="session")
def processed_url() -> str:
    """The dataset after the AP clerk sorted the inbox and the worker read every document: the state the
    trap checklist is judged on."""
    url = _database("ap_traps")
    with db.transaction(url) as conn:
        intake.process_inbox(conn, "U004")
    worker.drain(url)
    return url


@pytest.fixture
def pconn(processed_url):
    """A connection to the processed database whose changes are rolled back after each test."""
    with db.connect(processed_url) as c:
        yield c
        c.rollback()


@pytest.fixture
def api(pconn):
    """Call the real HTTP API as a given user, inside pconn's rolled-back transaction."""
    pconn.execute("SELECT 1")  # open the outer transaction; everything below nests inside it

    def same_conn():
        yield pconn

    app.dependency_overrides[get_conn] = same_conn
    client = TestClient(app)

    def call(method, path, user, **kwargs):
        return client.request(method, f"/api{path}", headers={"X-User-Id": user}, **kwargs)

    yield call
    app.dependency_overrides.clear()


def pytest_terminal_summary(terminalreporter):
    """After `make traps`, print the checklist: one line per trap, CAUGHT or MISSED."""
    reports = [r for key in ("passed", "failed") for r in terminalreporter.stats.get(key, [])
               if getattr(r, "when", None) == "call" and "test_traps.py" in r.nodeid]
    if not reports:
        return
    terminalreporter.section("TRAP_MAP checklist")
    for r in sorted(reports, key=lambda r: r.nodeid):
        name = r.nodeid.split("[", 1)[-1].rstrip("]")
        terminalreporter.write_line(f"  {'CAUGHT' if r.passed else 'MISSED'}  {name}")
    caught = sum(r.passed for r in reports)
    terminalreporter.write_line(f"\n  {caught} of {len(reports)} traps caught")


@pytest.fixture
def conn(db_url):
    """A connection whose changes are rolled back after each test."""
    with db.connect(db_url) as c:
        yield c
        c.rollback()
