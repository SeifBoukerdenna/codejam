"""Approvals queue for the current user, the global audit log, audit findings, and reference lists for forms."""

from fastapi import APIRouter, Depends

from app import findings
from app.auth import current_user
from app.db import get_conn

router = APIRouter(prefix="/api")


@router.get("/approvals/mine")
def my_approvals(conn=Depends(get_conn), user=Depends(current_user)):
    """Only the step that is waiting NOW: an invoice reaches step 2's approver after step 1 is done."""
    if not user:
        return []
    return conn.execute(
        """SELECT a.approval_id, a.invoice_id, a.step_no, a.approver_role, a.routing_note, a.on_behalf_of_user_id,
                  ob.full_name AS on_behalf_of_name, i.vendor_invoice_number, i.total_cad_cents, i.invoice_date,
                  coalesce(v.legal_name, 'Unknown vendor') AS vendor_name
           FROM approvals a
           JOIN invoices i USING (invoice_id)
           LEFT JOIN vendors v ON v.vendor_id = i.vendor_id
           LEFT JOIN users ob ON ob.user_id = a.on_behalf_of_user_id
           WHERE a.action = 'pending' AND a.approver_user_id = %s
             AND a.step_no = (SELECT min(step_no) FROM approvals x WHERE x.invoice_id = a.invoice_id AND x.action = 'pending')
           ORDER BY i.invoice_date, a.invoice_id""",
        (user["user_id"],),
    ).fetchall()


@router.get("/audit")
def audit_log(limit: int = 300, conn=Depends(get_conn)):
    return conn.execute(
        """SELECT e.*, u.full_name AS actor_name, ob.full_name AS on_behalf_of_name
           FROM audit_events e
           LEFT JOIN users u ON u.user_id = e.actor_user_id
           LEFT JOIN users ob ON ob.user_id = e.on_behalf_of_user_id
           ORDER BY e.event_id DESC LIMIT %s""",
        (min(limit, 2000),),
    ).fetchall()


@router.get("/findings")
def audit_findings(conn=Depends(get_conn)):
    doubles = findings.double_payments(conn)
    return {
        "self_approvals": findings.self_approvals(conn),
        "double_payments": doubles,
        "overpaid_cad_cents": sum(f["overpaid_cad_cents"] for f in doubles if f["kind"] != "about_to_pay_twice"),
        "split_invoices": findings.split_invoices(conn),
    }


@router.get("/reference")
def reference(conn=Depends(get_conn)):
    """Lists for the edit forms (departments, GL accounts, people, vendors, categories)."""
    return {
        "departments": conn.execute("SELECT department_id, name FROM departments ORDER BY name").fetchall(),
        "gl_accounts": conn.execute("SELECT account_number, name FROM gl_accounts WHERE account_type = 'expense' "
                                    "ORDER BY account_number").fetchall(),
        "users": conn.execute("SELECT user_id, full_name, title FROM users WHERE status = 'active' ORDER BY full_name").fetchall(),
        "vendors": conn.execute("SELECT vendor_id, legal_name, status FROM vendors ORDER BY legal_name").fetchall(),
        "categories": [r["category"] for r in conn.execute("SELECT DISTINCT category FROM vendors ORDER BY category")],
    }
