"""Approvals queue for the current user, and the global audit log."""

from fastapi import APIRouter, Depends

from app.auth import current_user
from app.db import get_conn

router = APIRouter(prefix="/api")


@router.get("/approvals/mine")
def my_approvals(conn=Depends(get_conn), user=Depends(current_user)):
    if not user:
        return []
    return conn.execute(
        """SELECT a.approval_id, a.invoice_id, a.step_no, a.approver_role, a.routing_note, a.on_behalf_of_user_id,
                  ob.full_name AS on_behalf_of_name, i.vendor_invoice_number, i.total_cad_cents, i.invoice_date,
                  v.legal_name AS vendor_name
           FROM approvals a
           JOIN invoices i USING (invoice_id)
           LEFT JOIN vendors v ON v.vendor_id = i.vendor_id
           LEFT JOIN users ob ON ob.user_id = a.on_behalf_of_user_id
           WHERE a.action = 'pending' AND a.approver_user_id = %s
           ORDER BY i.invoice_date, a.invoice_id""",
        (user["user_id"],),
    ).fetchall()


@router.get("/audit")
def audit_log(limit: int = 200, conn=Depends(get_conn)):
    return conn.execute(
        """SELECT e.*, u.full_name AS actor_name, ob.full_name AS on_behalf_of_name
           FROM audit_events e
           LEFT JOIN users u ON u.user_id = e.actor_user_id
           LEFT JOIN users ob ON ob.user_id = e.on_behalf_of_user_id
           ORDER BY e.event_id DESC LIMIT %s""",
        (min(limit, 1000),),
    ).fetchall()
