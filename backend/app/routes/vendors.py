"""Vendor management: list, vendor page, onboarding (with near-duplicate detection), approval and holds,
and bank-detail changes that only take effect after a callback.

Full bank account numbers never leave the server: the UI only gets the last 4 digits.
"""

from datetime import date

from fastapi import APIRouter, Body, Depends, HTTPException

from app import audit, config
from app.auth import can, current_user, require
from app.db import get_conn
from app.pipeline import evaluate
from app.vendor_match import lookalike_of_paid_vendor, similar_vendors
from app.workflow import payments

router = APIRouter(prefix="/api")

PENDING_BANK_CHANGE_SQL = """
    EXISTS (SELECT 1 FROM bank_change_history b
            WHERE b.vendor_id = v.vendor_id AND NOT b.verified_by_callback AND b.callback_outcome IS NULL)
"""
OPEN_INVOICE_STATUSES = ("needs_review", "on_hold", "pending_approval")


def _mask(vendor: dict) -> dict:
    account = vendor.pop("bank_account", None)
    vendor["bank_account_last4"] = account[-4:] if account else None
    return vendor


def _vendor(conn, vendor_id: str) -> dict:
    vendor = conn.execute("SELECT * FROM vendors WHERE vendor_id = %s", (vendor_id,)).fetchone()
    if not vendor:
        raise HTTPException(404, "Vendor not found")
    return vendor


def _recheck_vendor(conn, vendor_id: str, actor: str, reason: str) -> None:
    """A vendor change can unblock (or block) its open invoices and held payments: re-run them."""
    for inv in conn.execute("SELECT invoice_id FROM invoices WHERE vendor_id = %s AND status = ANY(%s)",
                            (vendor_id, list(OPEN_INVOICE_STATUSES))).fetchall():
        evaluate(conn, inv["invoice_id"], actor=actor, reason=reason)
    for pay in conn.execute("SELECT * FROM payments WHERE vendor_id = %s AND status IN ('held', 'prepared')",
                            (vendor_id,)).fetchall():
        reasons = payments.blockers(conn, pay)
        if pay["status"] == "held" and not reasons:
            payments.recheck_hold(conn, pay, {"user_id": actor})
        elif pay["status"] == "prepared" and reasons:
            conn.execute("UPDATE payments SET status = 'held', hold_reason = %s WHERE payment_id = %s",
                         (" ".join(reasons), pay["payment_id"]))
            audit.log(conn, actor=actor, action="payment.hold", entity_type="payment", entity_id=pay["payment_id"],
                      before={"status": "prepared"}, after={"status": "held"}, reason=" ".join(reasons))


@router.get("/vendors")
def list_vendors(conn=Depends(get_conn)):
    year_start = date(config.TODAY.year, 1, 1)
    return conn.execute(
        f"""SELECT v.vendor_id, v.legal_name, v.category, v.status, v.province_or_state, v.country,
                   coalesce(p.paid_cad_cents, 0)::bigint AS paid_this_year_cad_cents,
                   coalesce(i.invoice_count, 0) AS invoice_count,
                   {PENDING_BANK_CHANGE_SQL} AS bank_change_unverified
            FROM vendors v
            LEFT JOIN (SELECT vendor_id, sum(amount_cad_cents) AS paid_cad_cents FROM payments
                       WHERE paid_date BETWEEN %s AND %s GROUP BY vendor_id) p USING (vendor_id)
            LEFT JOIN (SELECT vendor_id, count(*) AS invoice_count FROM invoices GROUP BY vendor_id) i USING (vendor_id)
            ORDER BY v.legal_name""",
        (year_start, config.TODAY),
    ).fetchall()


@router.get("/vendors/similar")
def find_similar(name: str, gst: str | None = None, bank_account: str | None = None, email: str | None = None,
                 conn=Depends(get_conn)):
    """Live duplicate check for the onboarding form."""
    return similar_vendors(conn, name=name, gst=gst or None, bank_account=bank_account or None, email=email or None)


@router.get("/vendors/{vendor_id}")
def get_vendor(vendor_id: str, conn=Depends(get_conn), user=Depends(current_user)):
    vendor = conn.execute(f"SELECT v.*, {PENDING_BANK_CHANGE_SQL} AS bank_change_unverified FROM vendors v "
                          f"WHERE vendor_id = %s", (vendor_id,)).fetchone()
    if not vendor:
        raise HTTPException(404, "Vendor not found")
    year_start = date(config.TODAY.year, 1, 1)
    paid = conn.execute(
        """SELECT coalesce(sum(amount_cad_cents), 0)::bigint AS cents, count(*) AS count FROM payments
           WHERE vendor_id = %s AND paid_date BETWEEN %s AND %s""", (vendor_id, year_start, config.TODAY)).fetchone()
    bank_changes = conn.execute(
        """SELECT b.*, u.full_name AS changed_by_name, c.full_name AS callback_by_name FROM bank_change_history b
           LEFT JOIN users u ON u.user_id = b.changed_by_user_id LEFT JOIN users c ON c.user_id = b.callback_by_user_id
           WHERE b.vendor_id = %s ORDER BY b.changed_at DESC, b.change_id DESC""", (vendor_id,)).fetchall()
    for change in bank_changes:
        account = change.pop("new_bank_account", None)
        change["new_account_last4"] = change["new_account_last4"] or (account[-4:] if account else None)
        change["pending"] = not change["verified_by_callback"] and change["callback_outcome"] is None
        change["verify"] = can(conn, user, "vendor.verify_bank_change", change).as_dict() if change["pending"] else None
    contracts = conn.execute("SELECT * FROM contracts WHERE vendor_id = %s ORDER BY start_date DESC", (vendor_id,)).fetchall()
    # DECISION: PO balance is tax-included, see the decisions log in CLAUDE.md.
    purchase_orders = conn.execute(
        """SELECT po.*, coalesce(sum(i.total_cents), 0)::bigint AS invoiced_cents,
                  (po.total_amount_cents - coalesce(sum(i.total_cents), 0))::bigint AS remaining_cents
           FROM purchase_orders po LEFT JOIN invoices i ON i.po_id = po.po_id AND i.status <> 'rejected'
           WHERE po.vendor_id = %s GROUP BY po.po_id ORDER BY po.issue_date DESC""", (vendor_id,)).fetchall()
    invoices = conn.execute(
        """SELECT invoice_id, vendor_invoice_number, invoice_date, status, currency, total_cents, total_cad_cents,
                  is_credit_note FROM invoices WHERE vendor_id = %s
           ORDER BY invoice_date DESC NULLS FIRST, invoice_id DESC""", (vendor_id,)).fetchall()
    similar = similar_vendors(conn, name=vendor["legal_name"], gst=vendor["gst_hst_number"],
                              bank_account=vendor["bank_account"], email=vendor["ap_contact_email"], exclude_id=vendor_id)
    return {
        "vendor": _mask(vendor), "paid_this_year": paid, "bank_changes": bank_changes, "contracts": contracts,
        "purchase_orders": purchase_orders, "invoices": invoices, "similar": similar,
        "lookalike_of": lookalike_of_paid_vendor(conn, {**vendor, "bank_account": _vendor(conn, vendor_id)["bank_account"]}),
        "actions": {
            "approve": can(conn, user, "vendor.approve", vendor).as_dict() if vendor["status"] == "pending_review" else None,
            "hold": can(conn, user, "vendor.hold").as_dict() if vendor["status"] != "on_hold" else None,
            "release_hold": can(conn, user, "vendor.hold").as_dict() if vendor["status"] == "on_hold" else None,
            "request_bank_change": can(conn, user, "vendor.request_bank_change").as_dict(),
        },
    }


VENDOR_FIELDS = ("legal_name", "category", "default_gl_account", "address", "province_or_state", "country",
                 "gst_hst_number", "qst_number", "payment_terms_days", "preferred_payment_method", "bank_institution",
                 "bank_transit", "bank_account", "ap_contact_email", "requires_po")


@router.post("/vendors", status_code=201)
def onboard(body: dict = Body(...), conn=Depends(get_conn), user=Depends(current_user)):
    """New vendors always start as pending_review: they can't be paid until someone else approves them."""
    with conn.transaction():
        require(conn, user, "vendor.create")
        data = {k: (body.get(k) if body.get(k) not in ("", None) else None) for k in VENDOR_FIELDS}
        if not data["legal_name"] or not data["category"]:
            raise HTTPException(422, "A vendor needs at least a legal name and a category.")
        data["country"] = data["country"] or "CA"
        data["requires_po"] = bool(data["requires_po"])
        n = conn.execute("SELECT max(substring(vendor_id from 2)::int) + 1 AS n FROM vendors").fetchone()["n"]
        vendor_id = f"V{n:03d}"
        similar = similar_vendors(conn, name=data["legal_name"], gst=data["gst_hst_number"],
                                  bank_account=data["bank_account"], email=data["ap_contact_email"])
        conn.execute(
            f"""INSERT INTO vendors (vendor_id, {", ".join(VENDOR_FIELDS)}, accepts_card_payment, status, onboarded_at,
                                     created_by, bank_details_updated_at)
                VALUES (%(vendor_id)s, {", ".join(f"%({k})s" for k in VENDOR_FIELDS)}, false, 'pending_review',
                        %(today)s, %(user)s, %(bank_date)s)""",
            {**data, "vendor_id": vendor_id, "today": config.TODAY, "user": user["user_id"],
             "bank_date": config.TODAY if data["bank_account"] else None})
        audit.log(conn, actor=user["user_id"], action="vendor.onboard", entity_type="vendor", entity_id=vendor_id,
                  after={k: v for k, v in data.items() if k != "bank_account"},
                  reason=("Possible duplicates: " + "; ".join(f"{s['legal_name']} ({', '.join(s['reasons'])})" for s in similar))
                  if similar else "No similar vendor found")
        # Onboarded from an invoice that came in under an unknown vendor: attach it and re-check.
        if body.get("from_invoice_id"):
            conn.execute("UPDATE invoices SET vendor_id = %s WHERE invoice_id = %s AND vendor_id IS NULL",
                         (vendor_id, body["from_invoice_id"]))
            if data["default_gl_account"]:
                conn.execute("""UPDATE invoice_lines SET gl_account = %s, coding_reason = %s
                                WHERE invoice_id = %s AND gl_account IS NULL""",
                             (data["default_gl_account"], "New vendor's default account", body["from_invoice_id"]))
            evaluate(conn, body["from_invoice_id"], actor=user["user_id"], reason=f"Vendor onboarded as {vendor_id}")
    return {"vendor_id": vendor_id, "similar": similar}


@router.post("/vendors/{vendor_id}/approve")
def approve_vendor(vendor_id: str, conn=Depends(get_conn), user=Depends(current_user)):
    with conn.transaction():
        vendor = _vendor(conn, vendor_id)
        require(conn, user, "vendor.approve", vendor)
        if vendor["status"] != "pending_review":
            raise HTTPException(409, "Only a vendor pending review can be approved.")
        conn.execute("UPDATE vendors SET status = 'active', status_reason = NULL WHERE vendor_id = %s", (vendor_id,))
        audit.log(conn, actor=user["user_id"], action="vendor.approve", entity_type="vendor", entity_id=vendor_id,
                  before={"status": "pending_review"}, after={"status": "active"}, reason="Vendor reviewed and approved")
        _recheck_vendor(conn, vendor_id, user["user_id"], "Vendor approved")
    return {"status": "active"}


@router.post("/vendors/{vendor_id}/hold")
def hold_vendor(vendor_id: str, body: dict = Body(default={}), conn=Depends(get_conn), user=Depends(current_user)):
    release = bool(body.get("release"))
    reason = (body.get("reason") or "").strip()
    if not release and not reason:
        raise HTTPException(422, "Say why the vendor is put on hold.")
    with conn.transaction():
        vendor = _vendor(conn, vendor_id)
        require(conn, user, "vendor.hold")
        new_status = "active" if release else "on_hold"
        conn.execute("UPDATE vendors SET status = %s, status_reason = %s WHERE vendor_id = %s",
                     (new_status, None if release else reason, vendor_id))
        audit.log(conn, actor=user["user_id"], action="vendor.release_hold" if release else "vendor.hold",
                  entity_type="vendor", entity_id=vendor_id, before={"status": vendor["status"]},
                  after={"status": new_status}, reason=reason or "Hold released")
        _recheck_vendor(conn, vendor_id, user["user_id"], "Vendor hold changed")
    return {"status": new_status}


def record_bank_change(conn, vendor_id: str, user: dict, inst: str, transit: str, account: str, channel: str,
                       note: str | None = None) -> str:
    """Store a bank-change request as PENDING. The vendor record keeps its old details; every invoice and payment
    for the vendor is re-checked, so they're held until someone else verifies the change by callback.
    Used by the API below and by the 'Try to fool us' demo, so both behave exactly the same."""
    vendor = _vendor(conn, vendor_id)
    require(conn, user, "vendor.request_bank_change")
    n = conn.execute("SELECT max(substring(change_id from 4)::int) + 1 AS n FROM bank_change_history").fetchone()["n"]
    change_id = f"BC-{n:03d}"
    conn.execute(
        """INSERT INTO bank_change_history (change_id, vendor_id, changed_at, changed_by_user_id, request_channel,
                                            verified_by_callback, old_account_last4, new_account_last4,
                                            new_bank_institution, new_bank_transit, new_bank_account)
           VALUES (%s, %s, %s, %s, %s, false, %s, %s, %s, %s, %s)""",
        (change_id, vendor_id, config.TODAY, user["user_id"], channel,
         (vendor["bank_account"] or "")[-4:] or None, account[-4:], inst, transit, account))
    audit.log(conn, actor=user["user_id"], action="vendor.bank_change_requested", entity_type="vendor",
              entity_id=vendor_id, after={"change_id": change_id, "new_account_last4": account[-4:], "channel": channel},
              reason=note or "Payments to this vendor are held until someone verifies the change by calling the vendor")
    _recheck_vendor(conn, vendor_id, user["user_id"], f"Bank change {change_id} requested")
    return change_id


@router.post("/vendors/{vendor_id}/bank-changes", status_code=201)
def request_bank_change(vendor_id: str, body: dict = Body(...), conn=Depends(get_conn), user=Depends(current_user)):
    """Record a request to change bank details. Nothing changes on the vendor until it's verified by callback."""
    inst, transit, account = (str(body.get(k) or "").strip() for k in ("institution", "transit", "account"))
    channel = body.get("channel") or "email_request"
    if not (inst.isdigit() and len(inst) == 3 and transit.isdigit() and len(transit) == 5 and account.isdigit()):
        raise HTTPException(422, "Institution is 3 digits, transit 5 digits, account digits only.")
    with conn.transaction():
        change_id = record_bank_change(conn, vendor_id, user, inst, transit, account, channel)
    return {"change_id": change_id}


@router.post("/bank-changes/{change_id}/verify")
def verify_bank_change(change_id: str, body: dict = Body(...), conn=Depends(get_conn), user=Depends(current_user)):
    """Someone called the vendor at the number on file from BEFORE the change and asked them to confirm."""
    phone = (body.get("phone") or "").strip()
    outcome = body.get("outcome")
    if not phone or outcome not in ("confirmed", "rejected"):
        raise HTTPException(422, "Record the number you called and whether the vendor confirmed the change.")
    with conn.transaction():
        change = conn.execute("SELECT * FROM bank_change_history WHERE change_id = %s", (change_id,)).fetchone()
        if not change:
            raise HTTPException(404, "Bank change not found")
        require(conn, user, "vendor.verify_bank_change", change)
        if change["verified_by_callback"] or change["callback_outcome"]:
            raise HTTPException(409, "This change has already been verified or rejected.")
        conn.execute(
            """UPDATE bank_change_history SET verified_by_callback = %s, callback_by_user_id = %s, callback_at = now(),
                      callback_phone = %s, callback_outcome = %s WHERE change_id = %s""",
            (outcome == "confirmed", user["user_id"], phone, outcome, change_id))
        vendor_id = change["vendor_id"]
        if outcome == "confirmed" and change["new_bank_account"]:
            conn.execute(
                """UPDATE vendors SET bank_institution = %s, bank_transit = %s, bank_account = %s,
                          bank_details_updated_at = %s WHERE vendor_id = %s""",
                (change["new_bank_institution"], change["new_bank_transit"], change["new_bank_account"],
                 config.TODAY, vendor_id))
        if outcome == "rejected" and not change["new_bank_account"]:
            # Old-style change already written into the vendor record (like BC-009): the account on file is now
            # one the vendor says isn't theirs. Freeze the vendor until the right details are re-entered.
            conn.execute("UPDATE vendors SET status = 'on_hold', status_reason = %s WHERE vendor_id = %s",
                         (f"the vendor denied bank change {change_id}; the account on file may be a fraudster's", vendor_id))
        audit.log(conn, actor=user["user_id"], action=f"vendor.bank_change_{outcome}", entity_type="vendor",
                  entity_id=vendor_id, after={"change_id": change_id, "called": phone, "outcome": outcome},
                  reason=body.get("note") or f"Callback to {phone}: vendor {outcome} the change")
        _recheck_vendor(conn, vendor_id, user["user_id"], f"Bank change {change_id} {outcome}")
    return {"outcome": outcome}
