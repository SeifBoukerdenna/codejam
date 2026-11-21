"""Payments list for the payments dashboard."""

from fastapi import APIRouter, Depends

from app.db import get_conn

router = APIRouter(prefix="/api")

# Shared by the payments page and the home page so a payment row always has the same shape.
PAYMENT_ROWS_SQL = """
    SELECT p.payment_id, p.invoice_id, p.vendor_id, v.legal_name AS vendor_name, i.vendor_invoice_number,
           p.method, p.scheduled_date, p.paid_date, p.status, p.currency, p.amount_cents, p.amount_cad_cents,
           p.reference, p.hold_reason
    FROM payments p
    JOIN vendors v USING (vendor_id)
    JOIN invoices i USING (invoice_id)
"""

# The order a person expects to read each tab in: what's next first for upcoming money, newest first for history.
ORDER_BY_STATUS = {
    "scheduled": "p.scheduled_date ASC, p.payment_id",
    "outstanding": "p.paid_date DESC, p.payment_id DESC",
    "settled": "p.paid_date DESC, p.payment_id DESC",
}


@router.get("/payments")
def list_payments(status: str = "scheduled", conn=Depends(get_conn)):
    order = ORDER_BY_STATUS.get(status, "p.payment_id DESC")
    rows = conn.execute(f"{PAYMENT_ROWS_SQL} WHERE p.status = %s ORDER BY {order}", (status,)).fetchall()
    summary = conn.execute(
        """SELECT status, count(*) AS count, sum(amount_cad_cents)::bigint AS total_cad_cents,
                  min(scheduled_date) AS next_date
           FROM payments GROUP BY status"""
    ).fetchall()
    return {"payments": rows, "summary": {s["status"]: s for s in summary}}
