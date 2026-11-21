"""Bonus features: 'Try to fool us', tax credits at risk, drafted replies, getting double payments back.

Same setup as test_workflow.py: the real HTTP API on the processed database, rolled back after each test.
Fakes are read by process_document(), the function the worker runs for each queued file, so they go through
exactly the same extraction, checks and routing as a real invoice.
"""

import struct
import zlib
from datetime import date

import pytest

from app import findings, reconcile
from app.extraction.text import Unreadable, read_document
from app.pipeline import process_document
from app.workflow.cards import decide


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


# ── single-use virtual card ──

CARD = {"status": "active", "expires_on": date(2026, 12, 2), "limit_cents": 371634, "currency": "CAD"}
TODAY = date(2026, 11, 2)


@pytest.mark.parametrize("merchant, cents, card, approved, words", [
    ("NORTHBOUND COURIERS", 371634, CARD, True, "Approved"),
    ("NORTHBOUND COURIERS", 382783, CARD, False, "more than"),          # a 3% card fee added
    ("NORTHBOUND COURIERS", 185817, CARD, False, "less than"),          # part of it
    ("QUICKPAY ONLINE STORE", 371634, CARD, False, "only works at"),    # the card number leaked
    ("NORTHBOUND COURIERS", 371634, {**CARD, "status": "used"}, False, "already been charged"),
    ("NORTHBOUND COURIERS", 371634, {**CARD, "status": "cancelled"}, False, "cancelled"),
    ("NORTHBOUND COURIERS", 371634, {**CARD, "expires_on": date(2026, 11, 1)}, False, "expired"),
])
def test_card_rules_explain_every_decision(merchant, cents, card, approved, words):
    ok, reason = decide(card, "Northbound Couriers", merchant, cents, TODAY)
    assert ok is approved and words in reason


def test_pay_by_virtual_card_end_to_end(api, pconn):
    inv = "AP-00425"   # Northbound Couriers, approved, nothing blocks it
    pay = api("POST", f"/invoices/{inv}/payment", "U004", json={"method": "CARD"}).json()
    assert pay["method"] == "CARD" and pay["status"] == "prepared"
    assert api("POST", f"/payments/{pay['payment_id']}/release", "U004").status_code == 403   # preparer can't release
    released = api("POST", f"/payments/{pay['payment_id']}/release", "U003").json()
    card = api("GET", f"/invoices/{inv}", "U004").json()["card"]
    assert released["reference"] == card["card_id"] and card["status"] == "active"
    assert card["limit_cents"] == pay["amount_cents"] and card["sent_to"]
    # No "bank confirmation" shortcut: only the vendor's charge can settle a card payment.
    assert api("POST", f"/payments/{pay['payment_id']}/settle", "U004").status_code == 409

    charge = lambda amount: api("POST", f"/virtual-cards/{card['card_id']}/charges", "U004",  # noqa: E731
                                json={"merchant": "NORTHBOUND COURIERS", "amount": amount}).json()
    assert charge("3827.83")["approved"] is False
    assert pconn.execute("SELECT status FROM payments WHERE payment_id = %s", (pay["payment_id"],)).fetchone()["status"] == "released"
    assert charge("3716.34")["approved"] is True
    assert charge("3716.34")["approved"] is False                     # single use

    d = api("GET", f"/invoices/{inv}", "U004").json()
    assert d["invoice"]["status"] == "paid" and d["card"]["status"] == "used"
    assert [a["approved"] for a in d["card_attempts"]] == [False, True, False]
    txn = pconn.execute("SELECT * FROM card_transactions WHERE memo = %s", (f"AP payment {inv}",)).fetchone()
    assert txn["source"] == "ap_virtual_card" and txn["amount_cents"] == 371634


def test_stopping_a_card_payment_cancels_the_card(api, pconn):
    pay = api("POST", "/invoices/AP-00425/payment", "U004", json={"method": "CARD"}).json()
    api("POST", f"/payments/{pay['payment_id']}/release", "U003")
    card_id = pconn.execute("SELECT card_id FROM virtual_cards WHERE payment_id = %s", (pay["payment_id"],)).fetchone()["card_id"]
    assert api("POST", f"/payments/{pay['payment_id']}/cancel", "U003", json={"reason": "Vendor asked for EFT"}).status_code == 200
    r = api("POST", f"/virtual-cards/{card_id}/charges", "U004", json={"merchant": "NORTHBOUND COURIERS", "amount": "3716.34"}).json()
    assert r["approved"] is False and "cancelled" in r["reason"]


# ── bank statement check ──

def test_every_bank_debit_is_matched_or_explained(pconn):
    r = reconcile.check_statement(pconn)
    kinds = {}
    for line in r["lines"]:
        kinds[line["kind"]] = kinds.get(line["kind"], 0) + 1
    assert kinds["unknown_debit"] == 5            # pre-authorized debits nobody set up
    assert kinds["fee_without_cause"] == 6        # wire fees, but we never send wires
    assert kinds["bank_fee"] == 10                # monthly account fees, not booked
    assert kinds["cheque_cashed"] == 19           # cleared, but our books say "not cashed"
    assert kinds["amount_differs"] == 4           # 3 EFTs a cent over + 1 cheque cleared 5 cents over
    assert "unmatched" not in kinds and r["missing_from_statement"] == []
    altered = next(l for l in r["lines"] if l["bank_txn_id"] == "BK-00296")
    assert altered["payment_id"] == "PAY-00347" and altered["at_stake_cents"] == 5 and "altered" in altered["explanation"]
    assert r["unexplained_cents"] == 152309       # $1,523.09: only the extra cents count, not whole payments
    letter = reconcile.letter_to_bank(r, "Jordan Okafor")
    assert "PREAUTH DEBIT 913114" in letter and "(we sent $6,990.48 CAD)" in letter and "$1,523.09" in letter


def test_closing_bank_lines_is_audited_and_settles_cashed_cheques(api, pconn):
    assert api("POST", "/bank/ask", "U014").status_code == 403
    assert api("POST", "/bank/ask", "U004").json()["asked"] == 15
    assert api("POST", "/bank/ask", "U004").status_code == 409
    page = api("GET", "/bank", "U004").json()
    assert page["unexplained_cents"] == 0 and page["waiting_cents"] == 152309   # asked, not recovered

    assert api("POST", "/bank/book-fees", "U004").json()["booked"] == 10
    gl = pconn.execute("SELECT DISTINCT gl_account FROM statement_reviews WHERE resolution = 'fee_booked'").fetchall()
    assert [g["gl_account"] for g in gl] == ["7010"]

    assert api("POST", "/bank/cheques-cashed", "U004").json()["cashed"] == 19
    assert pconn.execute("SELECT status FROM payments WHERE payment_id = 'PAY-00005'").fetchone()["status"] == "settled"
    assert api("GET", "/bank", "U004").json()["to_explain"] == 0
    logged = pconn.execute("SELECT count(*) AS n FROM audit_events WHERE action LIKE 'bank.%%'").fetchone()["n"]
    assert logged == 15 + 10 + 19
