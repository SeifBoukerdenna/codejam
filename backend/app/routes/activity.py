"""Approvals queue for the current user, the global audit log, audit findings, and reference lists for forms."""

from fastapi import APIRouter, Body, Depends, HTTPException

from app import audit, audit_chain, findings
from app.auth import current_user, require
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
        f"""SELECT {audit_chain.EVENT_SELECT}, u.full_name AS actor_name, ob.full_name AS on_behalf_of_name
           FROM audit_events e
           LEFT JOIN users u ON u.user_id = e.actor_user_id
           LEFT JOIN users ob ON ob.user_id = e.on_behalf_of_user_id
           ORDER BY e.event_id DESC LIMIT %s""",
        (min(limit, 2000),),
    ).fetchall()


@router.get("/audit/verify")
def verify_audit_chain(conn=Depends(get_conn), user=Depends(current_user)):
    """Re-check every signature in the audit chain (audit_chain.py) and name the first event that doesn't match."""
    require(conn, user, "audit.verify")
    return audit_chain.verify(conn)


@router.get("/findings")
def audit_findings(conn=Depends(get_conn)):
    doubles = findings.double_payments(conn)
    recs = findings.recoveries(conn)
    at_risk = findings.tax_at_risk(conn)
    return {
        "self_approvals": findings.self_approvals(conn),
        "double_payments": doubles,
        "overpaid_cad_cents": sum(f["overpaid_cad_cents"] for f in doubles if f["kind"] != "about_to_pay_twice"),
        "recovered_cad_cents": sum(r["overpaid_cad_cents"] for r in recs if r["status"] == "recovered"),
        "to_recover_cad_cents": sum(r["overpaid_cad_cents"] for r in recs if r["status"] != "recovered"),
        "to_recover_count": sum(r["status"] != "recovered" for r in recs),
        "split_invoices": findings.split_invoices(conn),
        "tax_at_risk": at_risk,
        "tax_at_risk_cents": sum(r["at_risk_cents"] for r in at_risk),
    }


@router.get("/recoveries")
def list_recoveries(conn=Depends(get_conn), user=Depends(current_user)):
    signer = user["full_name"] if user else "Accounts Payable"
    return [{**r, "letter": findings.recovery_letter(r, signer)} for r in findings.recoveries(conn)]


@router.post("/recoveries/{key}/{step}")
def update_recovery(key: str, step: str, body: dict = Body(default={}), conn=Depends(get_conn), user=Depends(current_user)):
    """request = we asked the vendor for the money back; recovered = it arrived (refund or deduction)."""
    if step not in ("request", "recovered"):
        raise HTTPException(404, "Unknown step")
    with conn.transaction():
        require(conn, user, "recovery.update")
        item = next((r for r in findings.recoveries(conn) if r["key"] == key), None)
        if item is None:
            raise HTTPException(404, "No double payment with that key")
        if step == "request" and item["status"] != "to_recover":
            raise HTTPException(409, "A refund was already requested.")
        if step == "recovered" and item["status"] == "recovered":
            raise HTTPException(409, "Already recovered.")
        if step == "request":
            conn.execute(
                """INSERT INTO recoveries (recovery_key, vendor_id, amount_cents, status, requested_by, requested_at, note)
                   VALUES (%s, %s, %s, 'requested', %s, now(), %s)""",
                (key, item["vendor_id"], item["overpaid_cad_cents"], user["user_id"], body.get("note")))
        else:
            conn.execute(
                """INSERT INTO recoveries (recovery_key, vendor_id, amount_cents, status, recovered_by, recovered_at, note)
                   VALUES (%s, %s, %s, 'recovered', %s, now(), %s)
                   ON CONFLICT (recovery_key) DO UPDATE SET status = 'recovered', recovered_by = EXCLUDED.recovered_by,
                       recovered_at = now(), note = coalesce(EXCLUDED.note, recoveries.note)""",
                (key, item["vendor_id"], item["overpaid_cad_cents"], user["user_id"], body.get("note")))
        audit.log(conn, actor=user["user_id"], action=f"recovery.{'requested' if step == 'request' else 'recovered'}",
                  entity_type="vendor", entity_id=item["vendor_id"],
                  before={"status": item["status"]}, after={"status": "requested" if step == "request" else "recovered",
                                                            "payments": item["payment_ids"]},
                  reason=f"{item['vendor_name']} #{item['invoice_number']}: {item['overpaid_cad_cents'] / 100:,.2f} paid twice")
    return {"status": "requested" if step == "request" else "recovered"}


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
