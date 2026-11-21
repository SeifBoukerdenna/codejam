"""Tests run against their own database (ap_test on the same Postgres server), freshly seeded once per test
session, so they never touch the data you are demoing with and always start from the same state."""

import os

import psycopg
import pytest

from app import config, db, seed


def _test_database_url() -> str:
    return os.environ.get("TEST_DATABASE_URL") or config.DATABASE_URL.rsplit("/", 1)[0] + "/ap_test"


@pytest.fixture(scope="session")
def db_url() -> str:
    url = _test_database_url()
    server_url, name = url.rsplit("/", 1)
    # CREATE DATABASE cannot run inside a transaction, hence autocommit on the maintenance database.
    with psycopg.connect(server_url + "/postgres", autocommit=True) as admin:
        if not admin.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone():
            admin.execute(f'CREATE DATABASE "{name}"')
    seed.seed(url)
    return url


@pytest.fixture
def conn(db_url):
    """A connection whose changes are rolled back after each test."""
    with db.connect(db_url) as c:
        yield c
        c.rollback()
