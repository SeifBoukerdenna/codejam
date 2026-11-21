"""Simulated payments: prepare -> (held) -> release -> settled. No real money or bank API.

Lifecycle:
  prepared   an AP clerk created it for an approved invoice; waiting for release
  held       something must be fixed first (vendor not approved, bank change unverified, duplicate...)
  released   a finance manager/controller sent it (P09–P11); a simulated bank reference is assigned
  settled    the bank confirmed it went through (simulated by a button)
  cancelled  stopped before it went out (e.g. a duplicate)
History rows also have 'scheduled' (queued with the bank) and 'outstanding' (cheque mailed, not cashed).

Credit notes are never paid: approved ones are netted against the vendor's next payment.
"""

import secrets

from app import audit, config
from app.checks.duplicates import normalize_invoice_number
from app.money import apply_rate, fmt

ACTIVE_PAYMENT = ("prepared", "held", "released", "scheduled", "outstanding", "settled")


def new_payment_id(conn) -> str:
    n = conn.execute("SELECT nextval('payment_number_seq') AS n").fetchone()["n"]
    return f"PAY-{n:05d}"


def blockers(conn, payment: dict) -> list[str]:
    """Reasons this payment must not go out right now, in plain words. Empty list = OK to release."""
    reasons = []
    vendor = conn.execute("SELECT * FROM vendors WHERE vendor_id = %s", (payment["vendor_id"],)).fetchone()
    if vendor is None:
        return ["The vendor isn't in our vendor list."]
    if vendor["status"] == "pending_review":
        reasons.append(f"{vendor['legal_name']} hasn't been approved as a vendor yet.")
    if vendor["status"] == "on_hold":
        reasons.append(f"{vendor['legal_name']} is on hold.")
    pending = conn.execute(
        """SELECT * FROM bank_change_history WHERE vendor_id = %s AND NOT verified_by_callback
           AND callback_outcome IS NULL""", (vendor["vendor_id"],)).fetchone()
    if pending:
        reasons.append(f"Bank details changed on {pending['changed_at']:%b %-d} ({pending['request_channel'].replace('_', ' ')}) "
                       f"and not verified by calling the vendor.")
    if payment["method"] in ("EFT",) and not vendor["bank_account"]:
        reasons.append("No bank account on file for an EFT payment.")

    # Another live payment for the same invoice, or for an invoice with the same vendor + number.
    invoice = conn.execute("SELECT * FROM invoices WHERE invoice_id = %s", (payment["invoice_id"],)).fetchone()
    key = normalize_invoice_number(invoice["vendor_invoice_number"])
    others = conn.execute(
        """SELECT p.payment_id, p.status, p.invoice_id, i.vendor_invoice_number FROM payments p
           JOIN invoices i USING (invoice_id)
           WHERE p.vendor_id = %s AND p.payment_id <> %s AND p.status = ANY(%s) AND NOT i.is_credit_note""",
        (payment["vendor_id"], payment["payment_id"], list(ACTIVE_PAYMENT))).fetchall()
    for o in others:
        if o["invoice_id"] == payment["invoice_id"] or (key and normalize_invoice_number(o["vendor_invoice_number"]) == key):
            reasons.append(f"Invoice #{invoice['vendor_invoice_number']} already has payment {o['payment_id']} "
                           f"({o['status']}). Paying again would pay it twice.")
            break
    return reasons


def prepare(conn, invoice: dict, user: dict) -> dict:
    vendor = conn.execute("SELECT * FROM vendors WHERE vendor_id = %s", (invoice["vendor_id"],)).fetchone()
    method = vendor["preferred_payment_method"] or "EFT"
    today = config.TODAY
    # DECISION: pay on the due date (keeps cash longer), or today if it's already due.
    scheduled = max(today, invoice["due_date"] or today)

    # Net available credit notes for this vendor, oldest first, without going below zero.
    amount = invoice["total_cents"]
    applied = []
    for credit in conn.execute(
            """SELECT * FROM invoices WHERE vendor_id = %s AND is_credit_note AND status = 'approved'
               AND currency = %s ORDER BY invoice_date""", (invoice["vendor_id"], invoice["currency"])).fetchall():
        use = min(-credit["total_cents"], amount)
        if use <= 0:
            break
        amount -= use
        applied.append((credit, use))
    credit_total = sum(use for _, use in applied)

    fx = invoice["fx_rate_to_cad"] or 1
    payment = {
        "payment_id": new_payment_id(conn), "invoice_id": invoice["invoice_id"], "vendor_id": invoice["vendor_id"],
        "method": method, "scheduled_date": scheduled, "currency": invoice["currency"], "amount_cents": amount,
        "fx_rate_to_cad": fx, "amount_cad_cents": apply_rate(amount, fx), "credit_applied_cents": credit_total,
        "prepared_by": user["user_id"], "status": "prepared",
    }
    reasons = blockers(conn, payment)
    if reasons:
        payment["status"], payment["hold_reason"] = "held", " ".join(reasons)
    conn.execute(
        """INSERT INTO payments (payment_id, invoice_id, vendor_id, method, scheduled_date, currency, amount_cents,
                                 fx_rate_to_cad, amount_cad_cents, credit_applied_cents, prepared_by, status, hold_reason)
           VALUES (%(payment_id)s, %(invoice_id)s, %(vendor_id)s, %(method)s, %(scheduled_date)s, %(currency)s,
                   %(amount_cents)s, %(fx_rate_to_cad)s, %(amount_cad_cents)s, %(credit_applied_cents)s,
                   %(prepared_by)s, %(status)s, %(hold_reason)s)""", {"hold_reason": None, **payment})
    conn.execute("UPDATE invoices SET status = 'scheduled' WHERE invoice_id = %s", (invoice["invoice_id"],))
    audit.log(conn, actor=user["user_id"], action="payment.prepare", entity_type="invoice",
              entity_id=invoice["invoice_id"], after=payment,
              reason=payment.get("hold_reason") or f"{method} for {fmt(amount, invoice['currency'])}")
    for credit, use in applied:
        conn.execute("UPDATE invoices SET status = 'paid' WHERE invoice_id = %s", (credit["invoice_id"],))
        audit.log(conn, actor=user["user_id"], action="credit_note.applied", entity_type="invoice",
                  entity_id=credit["invoice_id"], after={"payment_id": payment["payment_id"], "applied_cents": use},
                  reason=f"Deducted from payment {payment['payment_id']} for invoice {invoice['invoice_id']}")
    return payment


def release(conn, payment: dict, user: dict) -> dict:
    """Send it (simulated). Blockers are re-checked at the last moment: a bank change may have arrived since."""
    reasons = blockers(conn, payment)
    if reasons:
        conn.execute("UPDATE payments SET status = 'held', hold_reason = %s WHERE payment_id = %s",
                     (" ".join(reasons), payment["payment_id"]))
        audit.log(conn, actor=user["user_id"], action="payment.hold", entity_type="payment",
                  entity_id=payment["payment_id"], before={"status": payment["status"]}, after={"status": "held"},
                  reason=" ".join(reasons))
        return {**payment, "status": "held", "hold_reason": " ".join(reasons)}
    prefix = {"EFT": "SIM-EFT", "CHEQUE": "SIM-CHQ", "CARD": "SIM-VC"}[payment["method"]]
    reference = f"{prefix}-{secrets.token_hex(4).upper()}"
    conn.execute("UPDATE payments SET status = 'released', released_by = %s, reference = %s WHERE payment_id = %s",
                 (user["user_id"], reference, payment["payment_id"]))
    audit.log(conn, actor=user["user_id"], action="payment.release", entity_type="payment",
              entity_id=payment["payment_id"], before={"status": payment["status"]},
              after={"status": "released", "reference": reference}, reason=f"Invoice {payment['invoice_id']}")
    return {**payment, "status": "released", "reference": reference}


def settle(conn, payment: dict, user: dict) -> None:
    """The (simulated) bank confirms the money arrived."""
    paid = config.TODAY
    conn.execute("UPDATE payments SET status = 'settled', paid_date = %s WHERE payment_id = %s",
                 (paid, payment["payment_id"]))
    conn.execute("UPDATE invoices SET status = 'paid' WHERE invoice_id = %s", (payment["invoice_id"],))
    if payment["method"] == "CARD":
        # A virtual card payment also shows up on the card feed, like the history's BRIM-VC rows.
        vendor = conn.execute("SELECT legal_name FROM vendors WHERE vendor_id = %s", (payment["vendor_id"],)).fetchone()
        n = conn.execute("SELECT count(*) + 1 AS n FROM card_transactions").fetchone()["n"]
        conn.execute(
            """INSERT INTO card_transactions (txn_id, card_id, cardholder_user_id, posted_date, merchant_descriptor,
                                              amount_cents, currency, amount_cad_cents, source, receipt_attached, memo)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'ap_virtual_card', true, %s)""",
            (f"CT-{n:05d}", f"VC-{payment['payment_id']}", payment["released_by"] or user["user_id"], paid,
             vendor["legal_name"].upper()[:24], payment["amount_cents"], payment["currency"],
             payment["amount_cad_cents"], f"AP payment {payment['invoice_id']}"))
    audit.log(conn, actor=user["user_id"], action="payment.settle", entity_type="payment",
              entity_id=payment["payment_id"], before={"status": payment["status"]},
              after={"status": "settled", "paid_date": paid}, reason="Bank confirmation (simulated)")


def cancel(conn, payment: dict, user: dict, reason: str) -> None:
    conn.execute("UPDATE payments SET status = 'cancelled' WHERE payment_id = %s", (payment["payment_id"],))
    conn.execute("UPDATE invoices SET status = 'approved' WHERE invoice_id = %s AND status IN ('scheduled', 'approved')",
                 (payment["invoice_id"],))
    audit.log(conn, actor=user["user_id"], action="payment.cancel", entity_type="payment",
              entity_id=payment["payment_id"], before={"status": payment["status"]}, after={"status": "cancelled"},
              reason=reason)
    # Credit notes that were netted against this payment become available again.
    for event in conn.execute(
            """SELECT entity_id FROM audit_events WHERE action = 'credit_note.applied'
               AND after->>'payment_id' = %s""", (payment["payment_id"],)).fetchall():
        conn.execute("UPDATE invoices SET status = 'approved' WHERE invoice_id = %s", (event["entity_id"],))


def recheck_hold(conn, payment: dict, user: dict) -> list[str]:
    reasons = blockers(conn, payment)
    if not reasons:
        conn.execute("UPDATE payments SET status = 'prepared', hold_reason = NULL WHERE payment_id = %s",
                     (payment["payment_id"],))
        audit.log(conn, actor=user["user_id"], action="payment.unhold", entity_type="payment",
                  entity_id=payment["payment_id"], before={"status": "held"}, after={"status": "prepared"},
                  reason="Nothing blocks it any more")
    return reasons

