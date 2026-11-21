"""Vendor list and vendor page.

Full bank account numbers never leave the server: the UI only gets the last 4 digits. Staff need to
recognise an account, not copy it, and a leaked screenshot then exposes nothing usable.
"""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException

from app import config
from app.db import get_conn

router = APIRouter(prefix="/api")

# A bank change that was never confirmed by calling the vendor puts every payment to that vendor on hold.
UNVERIFIED_BANK_CHANGE_SQL = """
    EXISTS (SELECT 1 FROM bank_change_history b
            WHERE b.vendor_id = v.vendor_id AND NOT b.verified_by_callback)
"""


def _mask(vendor: dict) -> dict:
    account = vendor.pop("bank_account", None)
    vendor["bank_account_last4"] = account[-4:] if account else None
    return vendor


@router.get("/vendors")
def list_vendors(conn=Depends(get_conn)):
    year_start = date(config.TODAY.year, 1, 1)
    return conn.execute(
        f"""SELECT v.vendor_id, v.legal_name, v.category, v.status, v.province_or_state, v.country,
                   coalesce(p.paid_cad_cents, 0)::bigint AS paid_this_year_cad_cents,
                   coalesce(i.invoice_count, 0) AS invoice_count,
                   {UNVERIFIED_BANK_CHANGE_SQL} AS bank_change_unverified
            FROM vendors v
            LEFT JOIN (SELECT vendor_id, sum(amount_cad_cents) AS paid_cad_cents FROM payments
                       WHERE paid_date BETWEEN %s AND %s GROUP BY vendor_id) p USING (vendor_id)
            LEFT JOIN (SELECT vendor_id, count(*) AS invoice_count FROM invoices GROUP BY vendor_id) i
                   USING (vendor_id)
            ORDER BY v.legal_name""",
        (year_start, config.TODAY),
    ).fetchall()


@router.get("/vendors/{vendor_id}")
def get_vendor(vendor_id: str, conn=Depends(get_conn)):
    vendor = conn.execute(
        f"SELECT v.*, {UNVERIFIED_BANK_CHANGE_SQL} AS bank_change_unverified FROM vendors v WHERE vendor_id = %s",
        (vendor_id,),
    ).fetchone()
    if not vendor:
        raise HTTPException(404, "Vendor not found")

    year_start = date(config.TODAY.year, 1, 1)
    paid = conn.execute(
        """SELECT coalesce(sum(amount_cad_cents), 0)::bigint AS cents, count(*) AS count FROM payments
           WHERE vendor_id = %s AND paid_date BETWEEN %s AND %s""",
        (vendor_id, year_start, config.TODAY),
    ).fetchone()

    bank_changes = conn.execute(
        """SELECT b.*, u.full_name AS changed_by_name FROM bank_change_history b
           LEFT JOIN users u ON u.user_id = b.changed_by_user_id
           WHERE b.vendor_id = %s ORDER BY b.changed_at DESC""",
        (vendor_id,),
    ).fetchall()
    for change in bank_changes:
        change.pop("new_bank_account", None)

    contracts = conn.execute(
        "SELECT * FROM contracts WHERE vendor_id = %s ORDER BY start_date DESC", (vendor_id,)).fetchall()

    # PO balance = PO amount minus the totals (tax included) of invoices already charged to it.
    # DECISION: tax-included, see the decisions log in CLAUDE.md.
    purchase_orders = conn.execute(
        """SELECT po.*, coalesce(sum(i.total_cents), 0)::bigint AS invoiced_cents
           FROM purchase_orders po
           LEFT JOIN invoices i ON i.po_id = po.po_id AND i.status <> 'rejected'
           WHERE po.vendor_id = %s
           GROUP BY po.po_id ORDER BY po.issue_date DESC""",
        (vendor_id,),
    ).fetchall()

    invoices = conn.execute(
        """SELECT i.invoice_id, i.vendor_invoice_number, i.invoice_date, i.status, i.currency, i.total_cents,
                  i.total_cad_cents, i.is_credit_note
           FROM invoices i WHERE i.vendor_id = %s
           ORDER BY i.invoice_date DESC NULLS FIRST, i.invoice_id DESC""",
        (vendor_id,),
    ).fetchall()

    return {"vendor": _mask(vendor), "paid_this_year": paid, "bank_changes": bank_changes,
            "contracts": contracts, "purchase_orders": purchase_orders, "invoices": invoices}
