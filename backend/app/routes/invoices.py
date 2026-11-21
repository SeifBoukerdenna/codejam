"""Invoice detail: everything about one invoice on one page (lines and coding, checks, approvals, payments,
audit history). This is the page the audit-trail requirement points at."""

from fastapi import APIRouter, Depends, HTTPException

from app.db import get_conn

router = APIRouter(prefix="/api")

SEVERITY_ORDER = "CASE severity WHEN 'block' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END"


@router.get("/invoices/{invoice_id}")
def get_invoice(invoice_id: str, conn=Depends(get_conn)):
    invoice = conn.execute(
        """SELECT i.*, v.legal_name AS vendor_name, v.status AS vendor_status, v.category AS vendor_category,
                  d.name AS department_name, u.full_name AS requester_name
           FROM invoices i
           LEFT JOIN vendors v USING (vendor_id)
           LEFT JOIN departments d ON d.department_id = i.department_id
           LEFT JOIN users u ON u.user_id = i.requester_user_id
           WHERE i.invoice_id = %s""",
        (invoice_id,),
    ).fetchone()
    if not invoice:
        raise HTTPException(404, "Invoice not found")

    lines = conn.execute(
        """SELECT l.*, g.name AS gl_name, d.name AS department_name
           FROM invoice_lines l
           LEFT JOIN gl_accounts g ON g.account_number = l.gl_account
           LEFT JOIN departments d ON d.department_id = l.department_id
           WHERE l.invoice_id = %s ORDER BY l.line_no""",
        (invoice_id,),
    ).fetchall()

    approvals = conn.execute(
        """SELECT a.*, u.full_name AS approver_name, ob.full_name AS on_behalf_of_name
           FROM approvals a
           JOIN users u ON u.user_id = a.approver_user_id
           LEFT JOIN users ob ON ob.user_id = a.on_behalf_of_user_id
           WHERE a.invoice_id = %s ORDER BY a.step_no""",
        (invoice_id,),
    ).fetchall()

    payments = conn.execute(
        """SELECT p.*, pu.full_name AS prepared_by_name, ru.full_name AS released_by_name
           FROM payments p
           LEFT JOIN users pu ON pu.user_id = p.prepared_by
           LEFT JOIN users ru ON ru.user_id = p.released_by
           WHERE p.invoice_id = %s ORDER BY p.payment_id""",
        (invoice_id,),
    ).fetchall()

    checks = conn.execute(
        f"SELECT * FROM check_results WHERE invoice_id = %s ORDER BY {SEVERITY_ORDER}, check_id",
        (invoice_id,),
    ).fetchall()

    history = conn.execute(
        """SELECT e.*, u.full_name AS actor_name, ob.full_name AS on_behalf_of_name
           FROM audit_events e
           LEFT JOIN users u ON u.user_id = e.actor_user_id
           LEFT JOIN users ob ON ob.user_id = e.on_behalf_of_user_id
           WHERE e.entity_type = 'invoice' AND e.entity_id = %s ORDER BY e.event_id""",
        (invoice_id,),
    ).fetchall()

    po = None
    if invoice["po_id"]:
        po = conn.execute("SELECT * FROM purchase_orders WHERE po_id = %s", (invoice["po_id"],)).fetchone()
    contract = None
    if invoice["contract_id"]:
        contract = conn.execute("SELECT * FROM contracts WHERE contract_id = %s",
                                (invoice["contract_id"],)).fetchone()

    return {"invoice": invoice, "lines": lines, "approvals": approvals, "payments": payments,
            "checks": checks, "history": history, "po": po, "contract": contract}
