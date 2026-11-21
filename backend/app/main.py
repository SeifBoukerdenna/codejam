"""HTTP API entry point. Each area of the app has its own router file in app/routes/.
Permissions are decided in app/auth.py (can), never in the routes themselves.

Money in every JSON response is integer cents (fields ending in _cents). The UI only formats it, it never
does money arithmetic.
"""

from fastapi import Depends, FastAPI

from app import config
from app.db import get_conn
from app.routes import activity, fool, home, inbox, invoices, payments, vendors

app = FastAPI(title="Harborline AP")

for module in (home, inbox, invoices, payments, vendors, activity, fool):
    app.include_router(module.router)

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
    return conn.execute(
        """SELECT u.user_id, u.full_name, u.title, u.role, u.status, u.department_id, d.name AS department
           FROM users u JOIN departments d USING (department_id)
           ORDER BY u.user_id"""
    ).fetchall()


@app.get("/api/stats")
def table_counts(conn=Depends(get_conn)):
    # Table names come from the constant list above, never from the request, so the f-string is safe.
    return {t: conn.execute(f"SELECT count(*) AS n FROM {t}").fetchone()["n"] for t in SEEDED_TABLES}
