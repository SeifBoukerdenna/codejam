"""Workflow and permissions through the real HTTP API, as the UI uses it.

Each test runs inside one database transaction that is rolled back at the end (the API's own transactions
become savepoints inside it), so tests don't affect each other or the trap checklist.
"""

import pytest
from fastapi.testclient import TestClient

from app.auth import can
from app.db import get_conn
from app.main import app
from app.workflow import payments
from app.workflow.routing import plan_route


@pytest.fixture
def api(pconn):
    pconn.execute("SELECT 1")  # open the outer transaction; everything below nests inside it

    def same_conn():
        yield pconn

    app.dependency_overrides[get_conn] = same_conn
    client = TestClient(app)

    def call(method, path, user, **kwargs):
        return client.request(method, f"/api{path}", headers={"X-User-Id": user}, **kwargs)

    yield call
    app.dependency_overrides.clear()


def invoice_id(conn, filename):
    return conn.execute("SELECT invoice_id FROM invoices i JOIN documents d USING (document_id) WHERE d.filename = %s",
                        (filename,)).fetchone()["invoice_id"]


def detail(api, inv, user="U004"):
    return api("GET", f"/invoices/{inv}", user).json()


def test_keystone_end_to_end(api, pconn):
    """Review -> acknowledge -> submit -> 2 approvals -> prepare -> release -> settle, every step audited."""
    inv = invoice_id(pconn, "keystonerackings-inv-002.pdf")
    d = detail(api, inv)
    assert d["invoice"]["status"] == "needs_review"
    warn = next(c for c in d["checks"] if c["code"] == "PO_OVER_BALANCE")

    assert api("POST", f"/invoices/{inv}/submit", "U004").status_code == 409          # warning not acknowledged
    assert api("POST", f"/invoices/{inv}/checks/{warn['check_id']}/acknowledge", "U004").status_code == 200
    assert api("POST", f"/invoices/{inv}/submit", "U004").json()["status"] == "pending_approval"

    steps = detail(api, inv)["approvals"]
    assert [(s["approver_user_id"], s["rule_ids"]) for s in steps] == [("U007", "P01"), ("U003", "P12")]
    assert api("POST", f"/invoices/{inv}/approve", "U003").status_code == 403           # step 1 is Dev's
    assert api("POST", f"/invoices/{inv}/approve", "U007").status_code == 200
    assert api("POST", f"/invoices/{inv}/approve", "U003").json()["status"] == "approved"

    pay = api("POST", f"/invoices/{inv}/payment", "U004").json()
    assert pay["status"] == "prepared" and pay["method"] == "CHEQUE"                    # Keystone is paid by cheque
    denied = api("POST", f"/payments/{pay['payment_id']}/release", "U003")
    assert denied.status_code == 403 and "P11" in denied.json()["detail"]               # Elise approved it
    assert api("POST", f"/payments/{pay['payment_id']}/release", "U004").status_code == 403   # clerks can't (P09)
    assert api("POST", f"/payments/{pay['payment_id']}/release", "U002").json()["status"] == "released"
    assert api("POST", f"/payments/{pay['payment_id']}/settle", "U004").status_code == 200
    assert detail(api, inv)["invoice"]["status"] == "paid"

    actions = [e["action"] for e in detail(api, inv)["history"]]
    for expected in ("invoice.create", "invoice.acknowledge_warning", "invoice.submit", "invoice.approve",
                     "invoice.fully_approved", "payment.prepare", "payment.release", "payment.settle"):
        assert expected in actions, expected


def test_auditor_and_employee_are_refused(api, pconn):
    inv = invoice_id(pconn, "keystonerackings-inv-002.pdf")
    assert api("POST", f"/invoices/{inv}/submit", "U006").status_code == 403    # auditor: read-only
    assert api("POST", "/inbox/process", "U013").status_code == 403             # employee
    assert api("POST", "/inbox/process", "U012").status_code == 403             # on leave


def test_controller_needed_over_100k(pconn):
    users = {u["user_id"]: u for u in pconn.execute("SELECT * FROM users")}
    big = {"status": "prepared", "amount_cad_cents": 15_000_000, "invoice_approver_ids": set(), "prepared_by": "U004"}
    assert not can(pconn, users["U003"], "payment.release", big).allowed             # P10
    assert can(pconn, users["U002"], "payment.release", big).allowed


def test_self_approval_escalates_to_manager(pconn):
    """P07: an IT invoice requested by the IT manager himself goes to his manager instead."""
    invoice = {"invoice_id": "X", "total_cad_cents": 500_000, "department_id": "D05", "requester_user_id": "U010"}
    route = plan_route(pconn, invoice, set(), None)
    assert route[0]["approver_user_id"] == "U001" and "P07" in route[0]["routing_note"]


def test_delegation_is_recorded(api, pconn):
    """P08: Liam (U012) is on leave, so Elise approves the Fixwell invoice on his behalf, and it says so."""
    inv = invoice_id(pconn, "fixwellfacilitys-inv-052.pdf")
    step = detail(api, inv)["approvals"][0]
    assert (step["approver_user_id"], step["on_behalf_of_user_id"]) == ("U003", "U012")
    assert api("POST", f"/invoices/{inv}/approve", "U003").status_code == 200
    event = next(e for e in detail(api, inv)["history"] if e["action"] == "invoice.approve")
    assert event["on_behalf_of_user_id"] == "U012"


def test_bank_change_holds_payments_until_someone_else_calls_back(api, pconn):
    inv = invoice_id(pconn, "polarfreightline_000963.pdf")
    assert detail(api, inv)["invoice"]["status"] == "pending_approval"
    r = api("POST", "/vendors/V001/bank-changes", "U004",
            json={"institution": "001", "transit": "12345", "account": "99887766", "channel": "email_request"})
    change = r.json()["change_id"]
    d = detail(api, inv)
    assert d["invoice"]["status"] == "on_hold" and any(c["code"] == "BANK_CHANGE_UNVERIFIED" for c in d["checks"])

    assert api("POST", f"/bank-changes/{change}/verify", "U004",
               json={"phone": "905-555-0100", "outcome": "confirmed"}).status_code == 403   # can't verify your own
    assert api("POST", f"/bank-changes/{change}/verify", "U005",
               json={"phone": "905-555-0100", "outcome": "confirmed"}).status_code == 200
    vendor = api("GET", "/vendors/V001", "U005").json()["vendor"]
    assert vendor["bank_account_last4"] == "7766" and not vendor["bank_change_unverified"]
    d = detail(api, inv)   # the old invoice still prints the old account: noted, not blocked
    assert d["invoice"]["status"] != "on_hold"
    assert any(c["code"] == "BANK_DETAILS_PREVIOUS_ACCOUNT" for c in d["checks"])


def test_onboarding_an_unknown_vendor_from_its_invoice(api, pconn):
    inv = invoice_id(pconn, "Invoice 4443.pdf")
    r = api("POST", "/vendors", "U004", json={
        "legal_name": "Blue Heron Couriers", "category": "Freight & Carriers", "default_gl_account": "5010",
        "province_or_state": "AB", "gst_hst_number": "324978405RT0001", "ap_contact_email": "ar@blueheron.example",
        "bank_institution": "002", "bank_transit": "39446", "bank_account": "38053633", "from_invoice_id": inv})
    vendor_id = r.json()["vendor_id"]
    codes = {c["code"] for c in detail(api, inv)["checks"]}
    assert "VENDOR_NOT_IN_MASTER" not in codes and "VENDOR_PENDING_REVIEW" in codes
    assert api("POST", f"/vendors/{vendor_id}/approve", "U004").status_code == 403    # clerks can't approve
    assert api("POST", f"/vendors/{vendor_id}/approve", "U003").json()["status"] == "active"


def test_onboarding_warns_about_duplicate_vendor(api):
    r = api("GET", "/vendors/similar?name=Great%20Lakes%20Carriers%20Incorporated&email=ar@greatlakes.example", "U004")
    assert any(s["vendor_id"] == "V002" and s["kind"] == "duplicate" for s in r.json())


def test_payment_to_pending_vendor_is_held(api, pconn):
    inv = invoice_id(pconn, "riverbendcaterin_1739.pdf")
    for c in detail(api, inv)["checks"]:
        if c["severity"] == "warn":
            api("POST", f"/invoices/{inv}/checks/{c['check_id']}/acknowledge", "U004")
    assert api("POST", f"/invoices/{inv}/submit", "U004").status_code == 200
    for step in detail(api, inv)["approvals"]:
        assert api("POST", f"/invoices/{inv}/approve", step["approver_user_id"]).status_code == 200
    pay = api("POST", f"/invoices/{inv}/payment", "U004").json()
    assert pay["status"] == "held" and "hasn't been approved" in pay["hold_reason"]


def test_scheduled_double_payment_blocked(pconn):
    pay = pconn.execute("SELECT * FROM payments WHERE payment_id = 'PAY-00399'").fetchone()
    assert any("pay it twice" in r for r in payments.blockers(pconn, pay))


def test_same_file_uploaded_twice_is_one_document(api):
    path = "/app/backend/../../data/brim_ap_dataset/incoming_invoices/Invoice 853.pdf"
    from app import config
    content = (config.DATA_DIR / "incoming_invoices" / "Invoice 853.pdf").read_bytes()
    r = api("POST", "/documents", "U004", files={"file": ("again.pdf", content, "application/pdf")})
    assert r.status_code == 409 and "already" in r.json()["detail"]
    assert path  # the name differs, the bytes don't: dedupe is by content (sha256), not filename
