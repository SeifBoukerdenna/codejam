"""GET /api/search?q= for the Cmd+K palette. The matching rules live in app/search.py; this only loads the rows."""

from fastapi import APIRouter, Depends

from app import search as matcher
from app.auth import current_user
from app.db import get_conn
from app.vendor_match import lookalike_of_paid_vendor

router = APIRouter(prefix="/api")


@router.get("/search")
def search(q: str = "", conn=Depends(get_conn), user=Depends(current_user)):
    query = q.strip()[:80]
    if not query:
        return {"invoices": [], "vendors": []}
    invoices = conn.execute(
        """SELECT i.invoice_id, i.vendor_id, coalesce(v.legal_name, e.fields->>'vendor_name') AS vendor_name,
                  i.vendor_invoice_number, i.invoice_date, i.status, i.currency, i.total_cents, i.total_cad_cents,
                  i.is_credit_note
           FROM invoices i
           LEFT JOIN vendors v ON v.vendor_id = i.vendor_id
           LEFT JOIN LATERAL (SELECT fields FROM extractions x WHERE x.document_id = i.document_id
                              ORDER BY extraction_id DESC LIMIT 1) e ON true""").fetchall()
    vendors = conn.execute(
        "SELECT vendor_id, legal_name, status, category, gst_hst_number, bank_account, ap_contact_email FROM vendors").fetchall()
    found = matcher.search(query, invoices, vendors)
    # The same warning the vendor's page shows, so "harlow" can't make the impostor look like the real firm.
    for v in found["vendors"]:
        real = lookalike_of_paid_vendor(conn, v)
        v["lookalike_of"] = real["legal_name"] if real else None
        del v["bank_account"], v["ap_contact_email"]     # the palette doesn't need bank details
    return found
