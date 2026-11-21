"""Step 1 checks: every CSV row made it into the database, and money survived the trip to the cent."""

import csv
import json
from decimal import Decimal

import psycopg
import pytest

from app import config
from app.seed import TABLES


@pytest.mark.parametrize("table,filename", [(t, f) for t, f, _ in TABLES])
def test_every_csv_row_is_loaded(conn, table, filename):
    with open(config.DATA_DIR / "data" / filename, newline="", encoding="utf-8") as f:
        expected = sum(1 for _ in csv.DictReader(f))
    assert conn.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"] == expected


def test_every_email_is_loaded(conn):
    emails = json.loads((config.DATA_DIR / "inbox" / "emails.json").read_text(encoding="utf-8"))
    assert conn.execute("SELECT count(*) AS n FROM emails").fetchone()["n"] == len(emails) == 59


def test_invoice_totals_match_the_csv_to_the_cent(conn):
    with open(config.DATA_DIR / "data" / "invoices.csv", newline="", encoding="utf-8") as f:
        expected = sum(Decimal(r["total_cad"]) for r in csv.DictReader(f)) * 100
    actual = conn.execute("SELECT sum(total_cad_cents) AS s FROM invoices").fetchone()["s"]
    assert actual == int(expected)


def test_queen_street_rent_amounts(conn):
    row = conn.execute("SELECT * FROM invoices WHERE invoice_id = 'AP-00002'").fetchone()
    assert (row["subtotal_cents"], row["gst_hst_cents"], row["total_cents"]) == (1660000, 215800, 1875800)


def test_bank_fields_keep_leading_zeros(conn):
    v = conn.execute("SELECT bank_institution FROM vendors WHERE vendor_id = 'V001'").fetchone()
    assert v["bank_institution"] == "004"


def test_policy_thresholds_are_parsed(conn):
    rows = conn.execute("SELECT rule_id, threshold_cents FROM approval_policies").fetchall()
    thresholds = {r["rule_id"]: r["threshold_cents"] for r in rows}
    assert thresholds["P01"] == thresholds["P02"] == 1_000_000      # $10,000
    assert thresholds["P03"] == 5_000_000                            # $50,000
    assert thresholds["P04"] == 25_000_000                           # $250,000
    assert thresholds["P09"] == thresholds["P10"] == 10_000_000      # $100,000
    assert thresholds["P05"] is None and thresholds["P11"] is None


def test_new_ids_continue_after_the_dataset(conn):
    assert conn.execute("SELECT nextval('invoice_number_seq') AS n").fetchone()["n"] == 427
    assert conn.execute("SELECT nextval('payment_number_seq') AS n").fetchone()["n"] == 416


def test_audit_log_is_append_only(conn):
    with pytest.raises(psycopg.errors.RaiseException, match="append-only"):
        conn.execute("UPDATE audit_events SET reason = 'tampered'")
    conn.rollback()
    with pytest.raises(psycopg.errors.RaiseException, match="append-only"):
        conn.execute("DELETE FROM audit_events")
