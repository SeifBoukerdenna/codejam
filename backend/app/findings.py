"""Audit findings over the whole history: problems that already happened, so the auditor can follow up.

  self_approvals   someone approved an invoice they requested (P07 broken in the past)
  double_payments  the same invoice paid more than once: twice through AP, or through AP and an employee card
                   (also catches two payments merely scheduled: money about to go out twice)
  split_invoices   invoices split to stay under the $10,000 approval limit

These use the same rules as the live checks (same invoice-number normalization, same split window), so the
history and new invoices are judged the same way.
"""

from collections import defaultdict

from app.checks.duplicates import card_descriptor_matches, normalize_invoice_number
from app.checks.splits import find_split_group
from app.vendor_match import similar_vendors

LIVE = ("settled", "outstanding", "scheduled", "prepared", "released")
CARD_MATCH_DAYS = 45


def self_approvals(conn) -> list[dict]:
    return conn.execute(
        """SELECT a.invoice_id, a.approver_user_id, u.full_name, a.acted_at, i.total_cad_cents, v.legal_name AS vendor_name
           FROM approvals a JOIN invoices i USING (invoice_id) JOIN users u ON u.user_id = a.approver_user_id
           LEFT JOIN vendors v ON v.vendor_id = i.vendor_id
           WHERE a.action = 'approved' AND a.approver_user_id = i.requester_user_id ORDER BY a.invoice_id""").fetchall()


def _vendor_families(conn) -> dict[str, str]:
    """Map each vendor to one id for its 'family', so duplicate vendor records (V001 / V051) count as one."""
    family = {}
    for v in conn.execute("SELECT * FROM vendors ORDER BY vendor_id"):
        if v["vendor_id"] in family:
            continue
        family[v["vendor_id"]] = v["vendor_id"]
        for s in similar_vendors(conn, name=v["legal_name"], gst=v["gst_hst_number"], bank_account=v["bank_account"],
                                 email=v["ap_contact_email"], exclude_id=v["vendor_id"]):
            if s["kind"] == "duplicate":
                family.setdefault(s["vendor_id"], v["vendor_id"])
    return family


def double_payments(conn) -> list[dict]:
    family = _vendor_families(conn)
    payments = conn.execute(
        """SELECT p.*, i.vendor_invoice_number, i.invoice_date, i.total_cad_cents, v.legal_name AS vendor_name
           FROM payments p JOIN invoices i USING (invoice_id) JOIN vendors v ON v.vendor_id = p.vendor_id
           WHERE p.status = ANY(%s) AND NOT i.is_credit_note ORDER BY coalesce(p.paid_date, p.scheduled_date), p.payment_id""",
        (list(LIVE),)).fetchall()

    groups = defaultdict(list)
    for p in payments:
        groups[(family.get(p["vendor_id"], p["vendor_id"]), normalize_invoice_number(p["vendor_invoice_number"]))].append(p)

    findings = []
    for (_, number), group in groups.items():
        # One real invoice, possibly entered more than once. Several payments of ONE invoice that add up to its
        # total are instalments, not a double payment; anything paid above the total is.
        invoice_total = max(p["total_cad_cents"] for p in group)
        paid = sum(p["amount_cad_cents"] + p["discount_taken_cents"] for p in group)
        overpaid = paid - invoice_total
        if len(group) > 1 and overpaid > 0:
            first = group[0]
            findings.append({
                "kind": "paid_twice" if all(p["status"] in ("settled", "outstanding") for p in group) else "about_to_pay_twice",
                "vendor_name": first["vendor_name"], "invoice_number": first["vendor_invoice_number"],
                "invoice_ids": sorted({p["invoice_id"] for p in group}), "payment_ids": [p["payment_id"] for p in group],
                "overpaid_cad_cents": overpaid,
                "message": f"{first['vendor_name']} #{first['vendor_invoice_number']} has {len(group)} payments "
                           f"({', '.join(p['payment_id'] + ' ' + p['status'] for p in group)}) for one invoice.",
            })

    # Paid through AP (EFT/cheque) AND on an employee card: same vendor, same amount, close dates.
    cards = conn.execute("SELECT * FROM card_transactions WHERE source = 'employee_card'").fetchall()
    by_invoice = defaultdict(list)
    for p in payments:
        if p["method"] == "CARD" or p["status"] not in ("settled", "outstanding"):
            continue
        for t in cards:
            # The card is charged the invoice total; AP may have paid less (early-payment discount).
            if (t["amount_cad_cents"] in (p["amount_cad_cents"], p["total_cad_cents"]) and card_descriptor_matches(p["vendor_name"], t["merchant_descriptor"])
                    and p["invoice_date"] and abs((t["posted_date"] - p["invoice_date"]).days) <= CARD_MATCH_DAYS):
                by_invoice[p["invoice_id"]].append((p, t))
    used_cards = set()
    for invoice_id, matches in by_invoice.items():
        for p, t in matches:
            if t["txn_id"] in used_cards:
                continue
            used_cards.add(t["txn_id"])
            findings.append({
                "kind": "paid_by_ap_and_card", "vendor_name": p["vendor_name"],
                "invoice_number": p["vendor_invoice_number"], "invoice_ids": [invoice_id],
                "payment_ids": [p["payment_id"], t["txn_id"]], "overpaid_cad_cents": t["amount_cad_cents"],
                "message": f"{p['vendor_name']} #{p['vendor_invoice_number']} was paid by AP ({p['payment_id']}) and "
                           f"also on an employee card ({t['txn_id']}, {t['posted_date']:%b %-d}).",
            })
            break
    return sorted(findings, key=lambda f: -f["overpaid_cad_cents"])


def split_invoices(conn) -> list[dict]:
    limit = conn.execute("SELECT threshold_cents FROM approval_policies WHERE rule_id = 'P01'").fetchone()["threshold_cents"]
    invoices = conn.execute(
        """SELECT i.*, v.legal_name AS vendor_name FROM invoices i JOIN vendors v USING (vendor_id)
           WHERE i.status <> 'rejected' ORDER BY i.invoice_date, i.invoice_id""").fetchall()
    by_vendor = defaultdict(list)
    for inv in invoices:
        by_vendor[inv["vendor_id"]].append(inv)
    seen, findings = set(), []
    for vendor_invoices in by_vendor.values():
        for inv in vendor_invoices:
            if inv["invoice_id"] in seen:
                continue
            group = find_split_group(inv, [o for o in vendor_invoices if o["invoice_id"] != inv["invoice_id"]], limit)
            if group:
                members = sorted([inv] + group, key=lambda o: o["invoice_id"])
                seen.update(o["invoice_id"] for o in members)
                findings.append({
                    "vendor_name": inv["vendor_name"], "invoice_ids": [o["invoice_id"] for o in members],
                    "combined_cad_cents": sum(o["total_cad_cents"] for o in members),
                    "message": f"{inv['vendor_name']}: {len(members)} invoices within a few days, each under $10,000, "
                               f"together over it.",
                })
    return findings
