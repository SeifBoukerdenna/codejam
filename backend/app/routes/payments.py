"""Payments dashboard and payment actions (release, settle, cancel, re-check a hold)."""

from fastapi import APIRouter, Body, Depends, HTTPException

from app import findings
from app.auth import current_user, require
from app.db import get_conn
from app.routes.invoices import payment_resource
from app.workflow import payments

router = APIRouter(prefix="/api")

# Shared by the payments page and the home page so a payment row always has the same shape.
PAYMENT_ROWS_SQL = """
    SELECT p.payment_id, p.invoice_id, p.vendor_id, v.legal_name AS vendor_name, i.vendor_invoice_number,
           p.method, p.scheduled_date, p.paid_date, p.status, p.currency, p.amount_cents, p.amount_cad_cents,
           p.credit_applied_cents, p.reference, p.hold_reason
    FROM payments p
    JOIN vendors v USING (vendor_id)
    JOIN invoices i USING (invoice_id)
"""

# The order a person expects to read each tab in: what's next first for money going out, newest first for history.
ORDER_BY_STATUS = {
    "prepared": "p.scheduled_date ASC, p.payment_id",
    "held": "p.payment_id DESC",
    "released": "p.scheduled_date ASC, p.payment_id",
    "scheduled": "p.scheduled_date ASC, p.payment_id",
    "outstanding": "p.paid_date DESC, p.payment_id DESC",
    "settled": "p.paid_date DESC, p.payment_id DESC",
    "cancelled": "p.payment_id DESC",
}


@router.get("/payments")
def list_payments(status: str = "prepared", conn=Depends(get_conn)):
    order = ORDER_BY_STATUS.get(status, "p.payment_id DESC")
    rows = conn.execute(f"{PAYMENT_ROWS_SQL} WHERE p.status = %s ORDER BY {order}", (status,)).fetchall()
    summary = conn.execute(
        """SELECT status, count(*) AS count, sum(amount_cad_cents)::bigint AS total_cad_cents,
                  min(scheduled_date) AS next_date
           FROM payments GROUP BY status"""
    ).fetchall()
    # Money about to go out twice: shown on top of the dashboard so it's stopped before release.
    twice = [f for f in findings.double_payments(conn) if f["kind"] == "about_to_pay_twice"]
    return {"payments": rows, "summary": {s["status"]: s for s in summary}, "about_to_pay_twice": twice}


def _payment(conn, payment_id: str) -> dict:
    payment = conn.execute("SELECT * FROM payments WHERE payment_id = %s", (payment_id,)).fetchone()
    if not payment:
        raise HTTPException(404, "Payment not found")
    return payment


@router.post("/payments/{payment_id}/release")
def release(payment_id: str, conn=Depends(get_conn), user=Depends(current_user)):
    with conn.transaction():
        payment = _payment(conn, payment_id)
        require(conn, user, "payment.release", payment_resource(conn, payment))
        result = payments.release(conn, payment, user)
    if result["status"] == "held":
        raise HTTPException(409, f"Not released, the payment is now on hold: {result['hold_reason']}")
    return result


@router.post("/payments/{payment_id}/settle")
def settle(payment_id: str, conn=Depends(get_conn), user=Depends(current_user)):
    with conn.transaction():
        payment = _payment(conn, payment_id)
        require(conn, user, "payment.settle")
        if payment["status"] not in ("released", "scheduled"):
            raise HTTPException(409, "Only a released payment can settle.")
        payments.settle(conn, payment, user)
    return {"status": "settled"}


@router.post("/payments/{payment_id}/cancel")
def cancel(payment_id: str, body: dict = Body(default={}), conn=Depends(get_conn), user=Depends(current_user)):
    reason = (body.get("reason") or "").strip()
    if not reason:
        raise HTTPException(422, "Say why the payment is stopped.")
    with conn.transaction():
        payment = _payment(conn, payment_id)
        require(conn, user, "payment.cancel")
        if payment["status"] not in ("prepared", "held", "released", "scheduled"):
            raise HTTPException(409, "This payment has already gone out.")
        payments.cancel(conn, payment, user, reason)
    return {"status": "cancelled"}


@router.post("/payments/{payment_id}/recheck")
def recheck(payment_id: str, conn=Depends(get_conn), user=Depends(current_user)):
    with conn.transaction():
        payment = _payment(conn, payment_id)
        require(conn, user, "payment.prepare")
        if payment["status"] != "held":
            raise HTTPException(409, "Only a held payment can be re-checked.")
        reasons = payments.recheck_hold(conn, payment, user)
    if reasons:
        raise HTTPException(409, "Still on hold: " + " ".join(reasons))
    return {"status": "prepared"}
