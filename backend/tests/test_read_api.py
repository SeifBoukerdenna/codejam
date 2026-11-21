"""Read endpoints behind the UI: they load, money stays integer cents, and sensitive data stays on the server."""

import pytest
from fastapi.testclient import TestClient

from app.db import connect, get_conn
from app.main import app


@pytest.fixture
def client(db_url):
    def test_conn():
        with connect(db_url) as conn:
            yield conn

    app.dependency_overrides[get_conn] = test_conn
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.mark.parametrize("path", [
    "/api/home", "/api/emails", "/api/emails/EM-002", "/api/invoices/AP-00002", "/api/payments?status=scheduled",
    "/api/payments?status=settled", "/api/vendors", "/api/vendors/V004", "/api/approvals/mine", "/api/audit",
])
def test_page_endpoints_load(client, path):
    assert client.get(path, headers={"X-User-Id": "U003"}).status_code == 200


def test_unknown_ids_are_404(client):
    assert client.get("/api/invoices/AP-99999").status_code == 404
    assert client.get("/api/vendors/V999").status_code == 404


def test_money_in_json_is_integer_cents(client):
    home = client.get("/api/home").json()
    assert isinstance(home["paid_this_year_cad_cents"], int)
    assert all(isinstance(m["total_cad_cents"], int) for m in home["paid_by_month"])
    assert isinstance(home["scheduled"]["total_cad_cents"], int)


def test_scheduled_payments_total(client):
    home = client.get("/api/home").json()
    assert home["scheduled"] == {"count": 18, "total_cad_cents": 7_480_198}


def test_full_bank_account_never_leaves_the_server(client):
    response = client.get("/api/vendors/V004")
    vendor = response.json()["vendor"]
    assert "bank_account" not in vendor
    assert vendor["bank_account_last4"] == "9679"
    assert "953389679" not in response.text


def test_unverified_bank_change_is_flagged(client):
    vendors = {v["vendor_id"]: v for v in client.get("/api/vendors").json()}
    assert vendors["V004"]["bank_change_unverified"] is True     # Cascadia, BC-009 by email
    assert vendors["V043"]["bank_change_unverified"] is False    # Fixwell, verified by callback


def test_attachments_only_serve_files_listed_on_the_email(client):
    ok = client.get("/api/emails/EM-002/attachments/keystonerackings-inv-002.pdf")
    assert ok.status_code == 200 and ok.headers["content-type"] == "application/pdf"
    # A real file, but attached to a different email.
    assert client.get("/api/emails/EM-002/attachments/scan_8049.png").status_code == 404
    assert client.get("/api/emails/EM-002/attachments/..%2F..%2Fdata%2Fusers.csv").status_code == 404
