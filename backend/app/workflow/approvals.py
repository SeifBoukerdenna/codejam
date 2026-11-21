"""Submitting an invoice for approval, and approving or declining a step. Permission checks happen in the
API layer through auth.can(); these functions assume the caller is allowed."""

from app import audit
from app.workflow.routing import plan_route


def new_approval_id(conn) -> str:
    n = conn.execute("SELECT nextval('approval_number_seq') AS n").fetchone()["n"]
    return f"AP-A-{n:05d}"


def current_step(conn, invoice_id: str) -> dict | None:
    return conn.execute(
        """SELECT a.*, u.full_name AS approver_name FROM approvals a JOIN users u ON u.user_id = a.approver_user_id
           WHERE a.invoice_id = %s AND a.action = 'pending' ORDER BY a.step_no LIMIT 1""", (invoice_id,)).fetchone()


def approver_ids(conn, invoice_id: str) -> set[str]:
    rows = conn.execute("SELECT approver_user_id FROM approvals WHERE invoice_id = %s AND action = 'approved'",
                        (invoice_id,)).fetchall()
    return {r["approver_user_id"] for r in rows}


def submit(conn, invoice: dict, check_codes: set[str], vendor: dict | None, actor: str | None, reason: str) -> None:
    steps = plan_route(conn, invoice, check_codes, vendor)
    for s in steps:
        conn.execute(
            """INSERT INTO approvals (approval_id, invoice_id, step_no, approver_user_id, approver_role, action,
                                      on_behalf_of_user_id, rule_ids, routing_note)
               VALUES (%s, %s, %s, %s, %s, 'pending', %s, %s, %s)""",
            (new_approval_id(conn), invoice["invoice_id"], s["step_no"], s["approver_user_id"],
             "dept_manager" if s["role"] == "dept_manager" else s["role"], s["on_behalf_of_user_id"],
             s["rule_ids"], s["routing_note"]))
    conn.execute("UPDATE invoices SET status = 'pending_approval', hold_reason = NULL WHERE invoice_id = %s",
                 (invoice["invoice_id"],))
    audit.log(conn, actor=actor, action="invoice.submit", entity_type="invoice", entity_id=invoice["invoice_id"],
              before={"status": invoice["status"]}, after={"status": "pending_approval", "route": steps}, reason=reason)


def withdraw(conn, invoice_id: str, actor: str | None, reason: str) -> None:
    """Take an invoice back out of approval (new information came in before anyone approved it).
    Pending steps are plans, not facts, so deleting them is fine; the audit log keeps the record."""
    conn.execute("DELETE FROM approvals WHERE invoice_id = %s AND action = 'pending'", (invoice_id,))
    audit.log(conn, actor=actor, action="invoice.withdraw_from_approval", entity_type="invoice", entity_id=invoice_id,
              reason=reason)


def act(conn, invoice: dict, step: dict, user: dict, approve: bool, comment: str | None) -> None:
    action = "approved" if approve else "rejected"
    conn.execute("UPDATE approvals SET action = %s, acted_at = now(), comment = %s WHERE approval_id = %s",
                 (action, comment, step["approval_id"]))
    audit.log(conn, actor=user["user_id"], on_behalf_of=step["on_behalf_of_user_id"],
              action=f"invoice.{'approve' if approve else 'decline'}", entity_type="invoice",
              entity_id=invoice["invoice_id"], before={"step": step["step_no"], "action": "pending"},
              after={"step": step["step_no"], "action": action, "rules": step["rule_ids"]}, reason=comment)
    if not approve:
        conn.execute("DELETE FROM approvals WHERE invoice_id = %s AND action = 'pending'", (invoice["invoice_id"],))
        conn.execute("UPDATE invoices SET status = 'rejected' WHERE invoice_id = %s", (invoice["invoice_id"],))
        audit.log(conn, actor=user["user_id"], action="invoice.rejected", entity_type="invoice",
                  entity_id=invoice["invoice_id"], before={"status": invoice["status"]}, after={"status": "rejected"},
                  reason=comment)
    elif current_step(conn, invoice["invoice_id"]) is None:
        conn.execute("UPDATE invoices SET status = 'approved' WHERE invoice_id = %s", (invoice["invoice_id"],))
        audit.log(conn, actor=user["user_id"], action="invoice.fully_approved", entity_type="invoice",
                  entity_id=invoice["invoice_id"], before={"status": invoice["status"]}, after={"status": "approved"},
                  reason="All approval steps done")
