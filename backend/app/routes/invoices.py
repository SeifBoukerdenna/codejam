"""Invoices: list, the full detail page, and every action on one (edit, acknowledge, submit, approve,
decline, reject, re-check, prepare payment). Each action asks auth.can() first and writes an audit event."""

from datetime import date

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import Response
from psycopg.types.json import Jsonb

from app import audit, findings
from app.auth import can, current_user, require
from app.db import get_conn
from app.extraction.extract import LABELS, doubtful_fields, overall
from app.money import apply_rate, to_cents
from app.pipeline import EDITABLE_STATUSES, evaluate, review_reasons
from app.vendor_match import lookalike_of_paid_vendor
from app.workflow import approvals, payments

router = APIRouter(prefix="/api")

SEVERITY_ORDER = "CASE severity WHEN 'block' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END"
LIVE_PAYMENT = ("prepared", "held", "released", "scheduled", "outstanding", "settled")


def _invoice(conn, invoice_id: str) -> dict:
    inv = conn.execute("SELECT * FROM invoices WHERE invoice_id = %s", (invoice_id,)).fetchone()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    return inv


def _live_payment(conn, invoice_id: str) -> dict | None:
    return conn.execute("SELECT * FROM payments WHERE invoice_id = %s AND status = ANY(%s) ORDER BY payment_id DESC LIMIT 1",
                        (invoice_id, list(LIVE_PAYMENT))).fetchone()


def payment_resource(conn, payment: dict) -> dict:
    """What can() needs to judge a release: the payment plus who approved its invoice (P11)."""
    return {**payment, "invoice_approver_ids": approvals.approver_ids(conn, payment["invoice_id"])}


def actions_for(conn, user, inv: dict) -> dict:
    """Which buttons this user gets on this invoice, each with allowed + the reason if not."""
    status = inv["status"]
    step = approvals.current_step(conn, inv["invoice_id"]) if status == "pending_approval" else None
    pay = _live_payment(conn, inv["invoice_id"])

    def c(action, resource=None):
        return can(conn, user, action, resource).as_dict()

    return {
        "edit": c("invoice.edit") if status in EDITABLE_STATUSES else None,
        "submit": c("invoice.submit") if status == "needs_review" else None,
        "recheck": c("invoice.recheck") if status in ("needs_review", "on_hold") else None,
        "reject": c("invoice.reject", inv) if status in ("needs_review", "on_hold", "pending_approval") else None,
        "approve": c("invoice.approve", step) if step else None,
        "decline": c("invoice.decline", step) if step else None,
        "prepare_payment": (c("payment.prepare") if status == "approved" and not inv["is_credit_note"] and not pay
                            else None),
        "release": c("payment.release", payment_resource(conn, pay)) if pay and pay["status"] == "prepared" else None,
        "settle": c("payment.settle") if pay and pay["status"] in ("released", "scheduled") else None,
        "cancel_payment": c("payment.cancel") if pay and pay["status"] in ("prepared", "held", "released", "scheduled") else None,
        "recheck_payment": c("payment.prepare") if pay and pay["status"] == "held" else None,
        "payment_id": pay["payment_id"] if pay else None,
    }


@router.get("/invoices")
def list_invoices(status: str = "needs_review,on_hold", conn=Depends(get_conn)):
    return conn.execute(
        """SELECT i.invoice_id, i.vendor_id, coalesce(v.legal_name, e.fields->>'vendor_name') AS vendor_name,
                  i.vendor_invoice_number, i.invoice_date, i.status, i.currency, i.total_cents, i.total_cad_cents,
                  i.hold_reason, i.is_credit_note, i.source
           FROM invoices i
           LEFT JOIN vendors v ON v.vendor_id = i.vendor_id
           LEFT JOIN LATERAL (SELECT fields FROM extractions x WHERE x.document_id = i.document_id
                              ORDER BY extraction_id DESC LIMIT 1) e ON true
           WHERE i.status = ANY(%s)
           ORDER BY i.created_at DESC, i.invoice_id DESC""", (status.split(","),)).fetchall()


@router.get("/invoices/{invoice_id}")
def get_invoice(invoice_id: str, conn=Depends(get_conn), user=Depends(current_user)):
    _invoice(conn, invoice_id)
    invoice = conn.execute(
        """SELECT i.*, v.legal_name AS vendor_name, v.status AS vendor_status, v.category AS vendor_category,
                  d.name AS department_name, u.full_name AS requester_name, r.full_name AS reviewed_by_name
           FROM invoices i
           LEFT JOIN vendors v USING (vendor_id)
           LEFT JOIN departments d ON d.department_id = i.department_id
           LEFT JOIN users u ON u.user_id = i.requester_user_id
           LEFT JOIN users r ON r.user_id = i.reviewed_by
           WHERE i.invoice_id = %s""", (invoice_id,)).fetchone()
    lines = conn.execute(
        """SELECT l.*, g.name AS gl_name, d.name AS department_name FROM invoice_lines l
           LEFT JOIN gl_accounts g ON g.account_number = l.gl_account
           LEFT JOIN departments d ON d.department_id = l.department_id
           WHERE l.invoice_id = %s ORDER BY l.line_no""", (invoice_id,)).fetchall()
    approval_rows = conn.execute(
        """SELECT a.*, u.full_name AS approver_name, ob.full_name AS on_behalf_of_name FROM approvals a
           JOIN users u ON u.user_id = a.approver_user_id LEFT JOIN users ob ON ob.user_id = a.on_behalf_of_user_id
           WHERE a.invoice_id = %s ORDER BY a.step_no""", (invoice_id,)).fetchall()
    payment_rows = conn.execute(
        """SELECT p.*, pu.full_name AS prepared_by_name, ru.full_name AS released_by_name FROM payments p
           LEFT JOIN users pu ON pu.user_id = p.prepared_by LEFT JOIN users ru ON ru.user_id = p.released_by
           WHERE p.invoice_id = %s ORDER BY p.payment_id""", (invoice_id,)).fetchall()
    checks = conn.execute(
        f"""SELECT c.*, u.full_name AS acknowledged_by_name FROM check_results c
            LEFT JOIN users u ON u.user_id = c.acknowledged_by
            WHERE invoice_id = %s ORDER BY {SEVERITY_ORDER}, check_id""", (invoice_id,)).fetchall()
    history = conn.execute(
        """SELECT e.*, u.full_name AS actor_name, ob.full_name AS on_behalf_of_name FROM audit_events e
           LEFT JOIN users u ON u.user_id = e.actor_user_id LEFT JOIN users ob ON ob.user_id = e.on_behalf_of_user_id
           WHERE (e.entity_type = 'invoice' AND e.entity_id = %s)
              OR (e.entity_type = 'payment' AND e.entity_id IN (SELECT payment_id FROM payments WHERE invoice_id = %s))
           ORDER BY e.event_id""", (invoice_id, invoice_id)).fetchall()

    extraction = None
    if invoice["document_id"]:
        x = conn.execute(
            """SELECT x.engine, x.fields, x.field_confidence, d.filename, d.document_id, d.mime_type
               FROM extractions x JOIN documents d USING (document_id)
               WHERE x.document_id = %s ORDER BY x.extraction_id DESC LIMIT 1""", (invoice["document_id"],)).fetchone()
        if x:
            extraction = {**x, "overall": overall(x["field_confidence"]),
                          "doubtful": [LABELS.get(f, f) for f in doubtful_fields(x["field_confidence"])]}

    # History invoices were never run through today's checks; show what the audit found about them instead.
    audit_notes = []
    if invoice["source"] == "history":
        if any(a["approver_user_id"] == invoice["requester_user_id"] and a["action"] == "approved" for a in approval_rows):
            audit_notes.append("Approved by the same person who requested it: self-approval, not allowed (P07).")
        for f in findings.double_payments(conn):
            if invoice_id in f["invoice_ids"]:
                audit_notes.append(f"{f['message']} Overpaid by ${f['overpaid_cad_cents'] / 100:,.2f}.")

    stored_checks = conn.execute("SELECT * FROM check_results WHERE invoice_id = %s", (invoice_id,)).fetchall()
    po = conn.execute("SELECT * FROM purchase_orders WHERE po_id = %s", (invoice["po_id"],)).fetchone() if invoice["po_id"] else None
    contract = (conn.execute("SELECT * FROM contracts WHERE contract_id = %s", (invoice["contract_id"],)).fetchone()
                if invoice["contract_id"] else None)
    return {
        "invoice": invoice, "lines": lines, "approvals": approval_rows, "payments": payment_rows, "checks": checks,
        "history": history, "po": po, "contract": contract, "extraction": extraction, "audit_notes": audit_notes,
        "review_reasons": review_reasons(conn, invoice, stored_checks) if invoice["status"] == "needs_review" else [],
        "actions": actions_for(conn, user, invoice),
    }


@router.get("/documents/{document_id}/file")
def document_file(document_id: int, download: bool = False, conn=Depends(get_conn)):
    doc = conn.execute("SELECT filename, mime_type, content FROM documents WHERE document_id = %s", (document_id,)).fetchone()
    if not doc:
        raise HTTPException(404, "Document not found")
    disposition = "attachment" if download else "inline"
    return Response(bytes(doc["content"]), media_type=doc["mime_type"],
                    headers={"Content-Disposition": f'{disposition}; filename="{doc["filename"]}"'})


# ── actions ──

INVOICE_FIELDS = {
    "vendor_id": str, "vendor_invoice_number": str, "invoice_date": date.fromisoformat,
    "due_date": date.fromisoformat, "ship_to_province": str, "department_id": str, "requester_user_id": str,
    "subtotal_cents": int, "gst_hst_cents": int, "pst_qst_cents": int, "total_cents": int,
}
PRINTED_FIELDS = ("vendor_gst", "bank_institution", "bank_transit", "bank_account")


@router.patch("/invoices/{invoice_id}")
def edit_invoice(invoice_id: str, changes: dict = Body(...), conn=Depends(get_conn), user=Depends(current_user)):
    """A person corrects what was read. Money arrives as dollars text ("3,339.00") and is stored as cents."""
    with conn.transaction():
        inv = _invoice(conn, invoice_id)
        require(conn, user, "invoice.edit")
        if inv["status"] not in EDITABLE_STATUSES:
            raise HTTPException(409, "This invoice can no longer be edited.")
        updates = {}
        for key, value in changes.items():
            if key in INVOICE_FIELDS:
                if key.endswith("_cents") and isinstance(value, str):
                    value = to_cents(value)
                updates[key] = INVOICE_FIELDS[key](value) if value not in (None, "") else None
        if "total_cents" in updates and updates["total_cents"] is not None:
            updates["total_cad_cents"] = apply_rate(updates["total_cents"], inv["fx_rate_to_cad"] or 1)
        before, after = audit.changed(inv, updates)
        if after:
            sets = ", ".join(f"{k} = %({k})s" for k in after)
            conn.execute(f"UPDATE invoices SET {sets} WHERE invoice_id = %(invoice_id)s", {**after, "invoice_id": invoice_id})
            if "department_id" in after:
                conn.execute("UPDATE invoice_lines SET department_id = %s WHERE invoice_id = %s",
                             (after["department_id"], invoice_id))
        printed = {k: changes[k] or None for k in PRINTED_FIELDS if k in changes}
        if printed and inv["document_id"]:
            x = conn.execute("SELECT extraction_id, fields FROM extractions WHERE document_id = %s "
                             "ORDER BY extraction_id DESC LIMIT 1", (inv["document_id"],)).fetchone()
            p_before, p_after = audit.changed(x["fields"], printed)
            if p_after:
                conn.execute("UPDATE extractions SET fields = %s WHERE extraction_id = %s",
                             (Jsonb({**x["fields"], **p_after}), x["extraction_id"]))
                before, after = {**before, **p_before}, {**after, **p_after}
        if not after:
            return {"changed": False}
        audit.log(conn, actor=user["user_id"], action="invoice.edit", entity_type="invoice", entity_id=invoice_id,
                  before=before, after=after, reason=changes.get("reason") or "Corrected by a person")
        result = evaluate(conn, invoice_id, actor=user["user_id"], reason="Fields corrected")
    return {"changed": True, **result}


@router.patch("/invoices/{invoice_id}/lines/{line_no}")
def recode_line(invoice_id: str, line_no: int, changes: dict = Body(...), conn=Depends(get_conn),
                user=Depends(current_user)):
    """Override the suggested GL account (or line type) for one line. The reason becomes the person's choice."""
    with conn.transaction():
        inv = _invoice(conn, invoice_id)
        require(conn, user, "invoice.edit")
        if inv["status"] not in EDITABLE_STATUSES:
            raise HTTPException(409, "This invoice can no longer be recoded.")
        line = conn.execute("SELECT * FROM invoice_lines WHERE invoice_id = %s AND line_no = %s",
                            (invoice_id, line_no)).fetchone()
        updates = {k: changes[k] for k in ("gl_account", "line_type") if k in changes}
        before, after = audit.changed(line, updates)
        if not after:
            return {"changed": False}
        sets = ", ".join(f"{k} = %({k})s" for k in after)
        conn.execute(f"UPDATE invoice_lines SET {sets}, coding_reason = %(reason)s, coded_by = %(user)s "
                     f"WHERE invoice_id = %(inv)s AND line_no = %(line)s",
                     {**after, "reason": f"Set by {user['full_name']} (was {line['gl_account']})", "user": user["user_id"],
                      "inv": invoice_id, "line": line_no})
        audit.log(conn, actor=user["user_id"], action="invoice.recode", entity_type="invoice", entity_id=invoice_id,
                  before={"line": line_no, **before}, after={"line": line_no, **after}, reason=line["coding_reason"])
        result = evaluate(conn, invoice_id, actor=user["user_id"], reason="Coding changed")
    return {"changed": True, **result}


@router.post("/invoices/{invoice_id}/checks/{check_id}/acknowledge")
def acknowledge(invoice_id: str, check_id: int, conn=Depends(get_conn), user=Depends(current_user)):
    with conn.transaction():
        require(conn, user, "invoice.acknowledge")
        check = conn.execute("SELECT * FROM check_results WHERE check_id = %s AND invoice_id = %s",
                             (check_id, invoice_id)).fetchone()
        if not check or check["severity"] != "warn":
            raise HTTPException(409, "Only warnings can be acknowledged; blocking problems have to be fixed.")
        conn.execute("UPDATE check_results SET acknowledged_by = %s, acknowledged_at = now() WHERE check_id = %s",
                     (user["user_id"], check_id))
        audit.log(conn, actor=user["user_id"], action="invoice.acknowledge_warning", entity_type="invoice",
                  entity_id=invoice_id, after={"code": check["code"]}, reason=check["message"])
    return {"ok": True}


@router.post("/invoices/{invoice_id}/submit")
def submit(invoice_id: str, conn=Depends(get_conn), user=Depends(current_user)):
    with conn.transaction():
        _invoice(conn, invoice_id)
        require(conn, user, "invoice.submit")
        result = evaluate(conn, invoice_id, actor=user["user_id"], reason="Submitted for approval", submit=True)
        if result["status"] != "pending_approval":
            raise HTTPException(409, " ".join(result["reasons"]) or "This invoice can't be submitted yet.")
    return result


@router.post("/invoices/{invoice_id}/recheck")
def recheck(invoice_id: str, conn=Depends(get_conn), user=Depends(current_user)):
    with conn.transaction():
        _invoice(conn, invoice_id)
        require(conn, user, "invoice.recheck")
        result = evaluate(conn, invoice_id, actor=user["user_id"], reason="Re-checked on request")
    return result


@router.post("/invoices/{invoice_id}/reject")
def reject(invoice_id: str, body: dict = Body(default={}), conn=Depends(get_conn), user=Depends(current_user)):
    reason = (body.get("reason") or "").strip()
    if not reason:
        raise HTTPException(422, "Say why it's rejected; the vendor and the audit log need a reason.")
    with conn.transaction():
        inv = _invoice(conn, invoice_id)
        require(conn, user, "invoice.reject", inv)
        conn.execute("DELETE FROM approvals WHERE invoice_id = %s AND action = 'pending'", (invoice_id,))
        conn.execute("UPDATE invoices SET status = 'rejected', hold_reason = %s WHERE invoice_id = %s", (reason, invoice_id))
        audit.log(conn, actor=user["user_id"], action="invoice.reject", entity_type="invoice", entity_id=invoice_id,
                  before={"status": inv["status"]}, after={"status": "rejected"}, reason=reason)
    return {"status": "rejected"}


def _act(invoice_id: str, approve: bool, body: dict, conn, user):
    with conn.transaction():
        inv = _invoice(conn, invoice_id)
        step = approvals.current_step(conn, invoice_id) if inv["status"] == "pending_approval" else None
        require(conn, user, "invoice.approve" if approve else "invoice.decline", step)
        comment = (body.get("comment") or "").strip() or None
        if not approve and not comment:
            raise HTTPException(422, "Say why you're declining it.")
        approvals.act(conn, inv, step, user, approve, comment)
    return {"status": conn.execute("SELECT status FROM invoices WHERE invoice_id = %s", (invoice_id,)).fetchone()["status"]}


@router.post("/invoices/{invoice_id}/approve")
def approve(invoice_id: str, body: dict = Body(default={}), conn=Depends(get_conn), user=Depends(current_user)):
    return _act(invoice_id, True, body, conn, user)


@router.post("/invoices/{invoice_id}/decline")
def decline(invoice_id: str, body: dict = Body(default={}), conn=Depends(get_conn), user=Depends(current_user)):
    return _act(invoice_id, False, body, conn, user)


@router.post("/invoices/{invoice_id}/payment")
def prepare_payment(invoice_id: str, conn=Depends(get_conn), user=Depends(current_user)):
    with conn.transaction():
        inv = _invoice(conn, invoice_id)
        require(conn, user, "payment.prepare")
        if inv["status"] != "approved":
            raise HTTPException(409, "Only an approved invoice can be paid.")
        if inv["is_credit_note"]:
            raise HTTPException(409, "Credit notes are never paid out; they're deducted from the next payment.")
        if _live_payment(conn, invoice_id):
            raise HTTPException(409, "This invoice already has a payment.")
        payment = payments.prepare(conn, inv, user)
    return payment
