"""Bonus features: 'Try to fool us', tax credits at risk, drafted replies, getting double payments back.

Same setup as test_workflow.py: the real HTTP API on the processed database, rolled back after each test.
Fakes are read by process_document(), the function the worker runs for each queued file, so they go through
exactly the same extraction, checks and routing as a real invoice.
"""

import struct
import zlib

import pytest

from app import findings
from app.extraction.text import Unreadable, read_document
from app.pipeline import process_document


def read_queued(conn, document_ids):
    for doc_id in document_ids:
        process_document(conn, doc_id)
        conn.execute("UPDATE extraction_jobs SET status = 'done' WHERE document_id = %s", (doc_id,))


def codes(conn, document_id):
    return {r["code"]: r for r in conn.execute(
        """SELECT c.* FROM check_results c JOIN invoices i USING (invoice_id) WHERE i.document_id = %s""", (document_id,))}


# trick -> (vendor it pretends to be, the check that must stop it)
TRICKS = {
    "bank-swap": ("V001", "BANK_DETAILS_MISMATCH"),
    "impostor": ("V036", "GST_NUMBER_MISMATCH"),
    "reused-number": ("V036", "DUPLICATE_INVOICE"),
    "wrong-tax": ("V038", "WRONG_TAX_FOR_PROVINCE"),
    "padded-total": ("V040", "TOTAL_DOESNT_ADD_UP"),
    "over-contract": ("V015", "OVER_FIXED_FEE"),
    "future-date": ("V007", "FUTURE_DATED"),
    "split": ("V033", "SPLIT_INVOICE"),
}


@pytest.mark.parametrize("key", TRICKS)
def test_every_fake_invoice_is_caught(api, pconn, key):
    vendor_id, expected = TRICKS[key]
    launched = api("POST", f"/fool/{key}", "U004").json()
    read_queued(pconn, launched["document_ids"])

    for doc_id in launched["document_ids"]:
        inv = pconn.execute("SELECT * FROM invoices WHERE document_id = %s", (doc_id,)).fetchone()
        assert inv["vendor_id"] == vendor_id, "the fake must be read as the vendor it imitates"
        found = codes(pconn, doc_id)
        assert expected in found, f"{key}: expected {expected}, got {sorted(found)}"
        assert inv["status"] in ("on_hold", "needs_review"), "a caught fake must never go straight to approval"

    page = api("GET", "/fool", "U004").json()
    mine = [a for a in page["attempts"] if a["document_id"] in launched["document_ids"]]
    assert len(mine) == 1, "one trick is one attempt, even when it sends two invoices"
    assert mine[0]["result"] == "caught" and mine[0]["reasons"]
    assert page["caught"] == page["finished"]


def test_fake_bank_change_by_email_holds_the_vendor(api, pconn):
    changed = api("POST", "/fool/bank-email", "U004").json()
    held = pconn.execute("""SELECT count(*) AS n FROM check_results WHERE code = 'BANK_CHANGE_UNVERIFIED'
                            AND details->>'change_id' = %s""", (changed["change_id"],)).fetchone()["n"]
    assert held > 0
    vendor = pconn.execute("SELECT bank_account FROM vendors WHERE vendor_id = 'V043'").fetchone()
    assert vendor["bank_account"] != "61839027", "the new account must not be used before a callback"
    # The person who recorded it can't also confirm it by phone (four-eyes).
    r = api("POST", f"/bank-changes/{changed['change_id']}/verify", "U004", json={"phone": "416-555-0100", "outcome": "confirmed"})
    assert r.status_code == 403
    attempt = next(a for a in api("GET", "/fool", "U004").json()["attempts"] if a["id"] == f"bank-{changed['change_id']}")
    assert attempt["result"] == "caught"


def test_only_ap_staff_can_launch_tricks(api):
    r = api("POST", "/fool/bank-swap", "U014")          # an employee
    assert r.status_code == 403 and r.json()["detail"]
    assert api("GET", "/fool", "U014").json()["can_try"]["allowed"] is False


def test_tax_credits_at_risk(pconn):
    rows = {(r["vendor_invoice_number"], r["code"]): r for r in findings.tax_at_risk(pconn)}
    # HST on an Alberta delivery: the 8% above GST can't be claimed back.
    assert rows[("000639", "WRONG_TAX_FOR_PROVINCE")]["at_risk_cents"] > 0
    # BC PST on services: PST is never recoverable.
    assert rows[("000970", "PST_ON_SERVICES")]["fix"]
    # No tax charged at all (Ironwood, Beaumont) means nothing was paid, so nothing is at risk.
    assert not any(n in ("INV-02210", "FA-000557") for n, _ in rows)
    # Duplicates are never paid, so their tax isn't at risk either.
    assert not any(n == "000961" for n, _ in rows)


def test_payment_question_gets_a_reply_from_the_payment_record(api, pconn):
    email = pconn.execute("SELECT * FROM emails WHERE email_id = 'EM-057'").fetchone()
    for fact in ("1743", "March 9, 2026", "$369.75", "BRIM-EFT-26388945"):
        assert fact in email["reply_draft"]
    resend = pconn.execute("SELECT reply_draft FROM emails WHERE email_id = 'EM-058'").fetchone()["reply_draft"]
    assert "attached" in resend
    assert pconn.execute("SELECT reply_draft FROM emails WHERE email_id = 'EM-059'").fetchone()["reply_draft"] is None

    assert api("POST", "/emails/EM-057/answered", "U014").status_code == 403
    assert api("POST", "/emails/EM-057/answered", "U004").json()["status"] == "answered"
    assert api("POST", "/emails/EM-057/answered", "U004").status_code == 409
    logged = pconn.execute("SELECT * FROM audit_events WHERE action = 'email.answered' AND entity_id = 'EM-057'").fetchone()
    assert logged["actor_user_id"] == "U004"


def test_getting_a_double_payment_back(api, pconn):
    items = api("GET", "/recoveries", "U004").json()
    assert sum(i["overpaid_cad_cents"] for i in items) == 2360192        # the $23,601.92 from the history
    first = items[0]
    assert first["status"] == "to_recover" and first["invoice_number"] in first["letter"]

    assert api("POST", f"/recoveries/{first['key']}/request", "U014").status_code == 403
    assert api("POST", f"/recoveries/{first['key']}/request", "U004").json()["status"] == "requested"
    assert api("POST", f"/recoveries/{first['key']}/request", "U004").status_code == 409
    assert api("POST", f"/recoveries/{first['key']}/recovered", "U003").json()["status"] == "recovered"

    totals = api("GET", "/findings", "U004").json()
    assert totals["recovered_cad_cents"] == first["overpaid_cad_cents"]
    assert totals["to_recover_cad_cents"] == 2360192 - first["overpaid_cad_cents"]
    actions = [r["action"] for r in pconn.execute(
        "SELECT action FROM audit_events WHERE action LIKE 'recovery.%%' ORDER BY event_id")]
    assert actions == ["recovery.requested", "recovery.recovered"]


def test_a_blank_image_is_refused_in_plain_words():
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = b"".join(b"\x00" + b"\xff" * 400 for _ in range(300))
    blank = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 400, 300, 8, 0, 0, 0, 0))
             + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
    with pytest.raises(Unreadable, match="couldn't find any text"):
        read_document(blank, "image/png")
