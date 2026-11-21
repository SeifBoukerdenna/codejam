"""Everything the checks need about one invoice, read from the database in one place.

Keeping all SQL here means the checks themselves are pure functions over a dict: easy to read, easy to test,
and the same invoice always gives the same results.
"""

from app import config
from app.checks.duplicates import card_descriptor_matches
from app.vendor_match import lookalike_of_paid_vendor, similar_vendors

TAX_LABEL = {"HST13": "HST", "GST5": "GST", "QST9975": "QST", "PST7_BC": "PST"}


def _taxes(inv: dict, lines: list[dict], codes: dict, printed: dict) -> list[dict]:
    """The taxes on the invoice: amounts from the invoice (which a person may have corrected), tax type from
    the line tax codes set when it was read."""
    gst_code = next((l["gst_hst_code"] for l in lines if l["gst_hst_code"] in ("HST13", "GST5")), None)
    pst_code = next((l["pst_qst_code"] for l in lines if l["pst_qst_code"] in ("QST9975", "PST7_BC")), None)
    printed_by_kind = {t["kind"]: t for t in printed.get("taxes", [])}
    taxes = []
    for kind, code, amount in (("gst_hst", gst_code, inv["gst_hst_cents"]), ("pst_qst", pst_code, inv["pst_qst_cents"])):
        if not amount:
            continue
        if code:
            rate = (codes[code]["rate"] * 100).normalize()
            taxes.append({"code": code, "label": TAX_LABEL[code], "rate_pct": f"{rate:f}", "amount_cents": amount})
        else:
            p = printed_by_kind.get(kind, {})
            taxes.append({"code": None, "label": p.get("label", "Tax"), "rate_pct": p.get("rate_pct", "?"),
                          "amount_cents": amount})
    return taxes


def _pick_contract(contracts: list[dict], invoice_date) -> dict | None:
    if not contracts:
        return None
    if invoice_date:
        covering = [c for c in contracts if c["start_date"] <= invoice_date <= c["end_date"]]
        if covering:
            return covering[0]
    return max(contracts, key=lambda c: c["end_date"])   # the latest one, possibly expired


def _pick_po(conn, inv: dict) -> dict | None:
    """The vendor's open PO for this invoice: the one it's already linked to, else the oldest open PO with
    enough left, else the oldest open PO."""
    pos = conn.execute(
        """SELECT po.*, po.total_amount_cents - coalesce(
                    (SELECT sum(i.total_cents) FROM invoices i
                     WHERE i.po_id = po.po_id AND i.invoice_id <> %(inv)s AND i.status <> 'rejected'), 0)::bigint
                  AS remaining_cents
           FROM purchase_orders po
           WHERE po.vendor_id = %(vendor)s AND (po.status IN ('open', 'partially_invoiced') OR po.po_id = %(po)s)
           ORDER BY (po.po_id = %(po)s) DESC NULLS LAST, po.issue_date""",
        {"inv": inv["invoice_id"], "vendor": inv["vendor_id"], "po": inv["po_id"]},
    ).fetchall()
    if not pos:
        return None
    if inv["po_id"] and pos[0]["po_id"] == inv["po_id"]:
        return pos[0]
    return next((p for p in pos if p["remaining_cents"] >= (inv["total_cents"] or 0)), pos[0])


def build_context(conn, invoice_id: str) -> dict:
    inv = conn.execute("SELECT * FROM invoices WHERE invoice_id = %s", (invoice_id,)).fetchone()
    lines = conn.execute("SELECT * FROM invoice_lines WHERE invoice_id = %s ORDER BY line_no", (invoice_id,)).fetchall()
    printed = {}
    if inv["document_id"]:
        row = conn.execute("SELECT fields FROM extractions WHERE document_id = %s ORDER BY extraction_id DESC LIMIT 1",
                           (inv["document_id"],)).fetchone()
        printed = row["fields"] if row else {}
    codes = {c["code"]: c for c in conn.execute("SELECT * FROM tax_codes")}
    vendor = (conn.execute("SELECT * FROM vendors WHERE vendor_id = %s", (inv["vendor_id"],)).fetchone()
              if inv["vendor_id"] else None)

    ctx = {
        "today": config.TODAY,
        "invoice": inv,
        "lines": lines,
        "printed": printed,
        "vendor": vendor,
        "tax_codes": codes,
        "printed_taxes": _taxes(inv, lines, codes, printed),
        "goods_subtotal_cents": sum(l["amount_cents"] for l in lines if l["line_type"] == "goods"),
        "thresholds": {r["rule_id"]: r["threshold_cents"] for r in conn.execute("SELECT * FROM approval_policies")},
        "lookalike": None, "pending_bank_change": None, "previous_accounts_last4": set(), "contract": None, "po": None,
        "vendor_invoices": [], "card_matches": [], "vendor_month_to_date_cents": 0,
    }
    if vendor is None:
        return ctx

    ctx["lookalike"] = lookalike_of_paid_vendor(conn, vendor)
    # Accounts this vendor used before a VERIFIED change: an invoice printing one of those is just old paperwork.
    ctx["previous_accounts_last4"] = {r["old_account_last4"] for r in conn.execute(
        "SELECT old_account_last4 FROM bank_change_history WHERE vendor_id = %s AND verified_by_callback",
        (vendor["vendor_id"],)) if r["old_account_last4"]}
    ctx["pending_bank_change"] = conn.execute(
        """SELECT * FROM bank_change_history WHERE vendor_id = %s AND NOT verified_by_callback
           AND callback_outcome IS NULL ORDER BY changed_at DESC LIMIT 1""", (vendor["vendor_id"],)).fetchone()
    contracts = conn.execute("SELECT * FROM contracts WHERE vendor_id = %s", (vendor["vendor_id"],)).fetchall()
    ctx["contract"] = _pick_contract(contracts, inv["invoice_date"])
    ctx["po"] = _pick_po(conn, inv)

    # The same company may exist twice in the vendor master (V001 / V051 share a bank account), so its
    # invoices are looked up under every record that is a duplicate of this one.
    vendor_ids = [vendor["vendor_id"]] + [
        s["vendor_id"] for s in similar_vendors(conn, name=vendor["legal_name"], gst=vendor["gst_hst_number"],
                                                bank_account=vendor["bank_account"], email=vendor["ap_contact_email"],
                                                exclude_id=vendor["vendor_id"]) if s["kind"] == "duplicate"]
    ctx["vendor_invoices"] = conn.execute(
        """SELECT i.*, EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.invoice_id AND p.method = 'CARD'
                               AND p.status <> 'cancelled') AS paid_by_card
           FROM invoices i
           WHERE i.vendor_id = ANY(%s) AND i.invoice_id <> %s AND i.status <> 'rejected'
           ORDER BY i.invoice_date DESC NULLS LAST""", (vendor_ids, invoice_id)).fetchall()

    if inv["invoice_date"]:
        ctx["vendor_month_to_date_cents"] = sum(
            o["subtotal_cents"] or 0 for o in ctx["vendor_invoices"]
            if o["invoice_date"] and o["invoice_date"].replace(day=1) == inv["invoice_date"].replace(day=1)
            and o["vendor_id"] == vendor["vendor_id"])

    if inv["total_cad_cents"]:
        candidates = conn.execute(
            """SELECT t.*, u.full_name AS cardholder_name FROM card_transactions t
               JOIN users u ON u.user_id = t.cardholder_user_id
               WHERE t.amount_cad_cents = %s AND t.source = 'employee_card'
                 AND coalesce(t.memo, '') NOT LIKE %s""",
            (inv["total_cad_cents"], f"%{invoice_id}%")).fetchall()
        ctx["card_matches"] = [t for t in candidates if card_descriptor_matches(vendor["legal_name"], t["merchant_descriptor"])]
    return ctx

