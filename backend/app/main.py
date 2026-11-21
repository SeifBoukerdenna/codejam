"""HTTP API. Step 1 only exposes what the UI needs to prove the stack works: health, the user list for the
demo user switcher, and row counts of the seeded tables."""

from fastapi import Depends, FastAPI

from app import config
from app.db import get_conn

app = FastAPI(title="Harborline AP")

SEEDED_TABLES = [
    "departments", "users", "gl_accounts", "tax_codes", "fx_rates", "approval_policies", "vendors",
    "bank_change_history", "contracts", "purchase_orders", "invoices", "invoice_lines", "approvals",
    "payments", "bank_statement", "card_transactions", "emails", "audit_events",
]


@app.get("/api/health")
def health(conn=Depends(get_conn)):
    conn.execute("SELECT 1")
    return {"ok": True, "today": config.TODAY.isoformat()}


@app.get("/api/users")
def list_users(conn=Depends(get_conn)):
    # DECISION: no real login. The UI's user switcher sends the chosen user_id in an X-User-Id header and the
    # server enforces every permission from that user's role and status (see auth.py, step 3).
    return conn.execute(
        """SELECT u.user_id, u.full_name, u.title, u.role, u.status, u.department_id, d.name AS department
           FROM users u JOIN departments d USING (department_id)
           ORDER BY u.user_id"""
    ).fetchall()


@app.get("/api/stats")
def table_counts(conn=Depends(get_conn)):
    # Table names come from the constant list above, never from the request, so the f-string is safe.
    return {t: conn.execute(f"SELECT count(*) AS n FROM {t}").fetchone()["n"] for t in SEEDED_TABLES}
