"""Which vendor sent this invoice, and which vendors look suspiciously alike.

Matching order, strongest evidence first: GST number, then bank account, then sender email, then name.
Similarity between vendor names ignores punctuation, "&" vs "and", and legal suffixes (Inc, Ltd, LLP...),
so "Harlow & Stern LLP" and "Harlow and Stern LLP" compare as identical.
"""

import re
from difflib import SequenceMatcher

NAME_MATCH = 0.90      # same vendor, written slightly differently
NAME_SIMILAR = 0.85    # close enough that a person could mistake one for the other

LEGAL_SUFFIXES = r"\b(incorporated|inc|limited|ltd|llp|llc|co|corp|corporation|company|s\.?e\.?n\.?c\.?r\.?l)\b\.?"


def normalize_name(name: str) -> str:
    n = name.lower().replace("&", " and ")
    n = re.sub(LEGAL_SUFFIXES, " ", n)
    n = re.sub(r"[^a-z0-9 ]", " ", n)
    return " ".join(n.split())


def name_similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, normalize_name(a), normalize_name(b)).ratio()


def email_domain(email: str | None) -> str | None:
    return email.split("@")[-1].lower() if email and "@" in email else None


def match_vendor(conn, fields: dict, sender_email: str | None) -> tuple[str | None, str]:
    """Return (vendor_id, how it was matched) or (None, why not)."""
    vendors = conn.execute("SELECT * FROM vendors ORDER BY (status = 'active') DESC, vendor_id").fetchall()
    gst = fields.get("vendor_gst")
    if gst:
        for v in vendors:
            if v["gst_hst_number"] == gst:
                return v["vendor_id"], f"GST number {gst} matches {v['legal_name']}"
    account = fields.get("bank_account")
    if account:
        for v in vendors:
            if v["bank_account"] == account:
                return v["vendor_id"], f"Bank account ••••{account[-4:]} matches {v['legal_name']}"
    if sender_email:
        for v in vendors:
            if v["ap_contact_email"] and v["ap_contact_email"].lower() == sender_email.lower():
                return v["vendor_id"], f"Sender {sender_email} is {v['legal_name']}'s billing email"
    name = fields.get("vendor_name")
    if name:
        best = max(vendors, key=lambda v: name_similarity(name, v["legal_name"]))
        if name_similarity(name, best["legal_name"]) >= NAME_MATCH:
            return best["vendor_id"], f"Name matches {best['legal_name']}"
    return None, f"No vendor in our list matches “{name or 'unknown'}”"


def similar_vendors(conn, *, name: str, gst: str | None = None, bank_account: str | None = None,
                    email: str | None = None, exclude_id: str | None = None) -> list[dict]:
    """Vendors that could be the same company (duplicate record) or an imitation of it.

    kind = 'duplicate'  same GST, bank account or email: probably the same company entered twice
    kind = 'lookalike'  similar name but different GST AND bank account: possibly an impersonator
    """
    paid = {r["vendor_id"]: r["n"] for r in conn.execute(
        "SELECT vendor_id, count(*) AS n FROM payments WHERE status IN ('settled', 'outstanding') GROUP BY vendor_id")}
    results = []
    for v in conn.execute("SELECT * FROM vendors WHERE vendor_id IS DISTINCT FROM %s", (exclude_id,)):
        reasons = []
        if gst and v["gst_hst_number"] == gst:
            reasons.append("same GST number")
        if bank_account and v["bank_account"] == bank_account:
            reasons.append("same bank account")
        if email and v["ap_contact_email"] and v["ap_contact_email"].lower() == email.lower():
            reasons.append("same billing email")
        similarity = name_similarity(name, v["legal_name"])
        if reasons and similarity >= 0.6:
            results.append({"vendor_id": v["vendor_id"], "legal_name": v["legal_name"], "status": v["status"],
                            "kind": "duplicate", "reasons": reasons + [f"name {round(similarity * 100)}% similar"],
                            "payments": paid.get(v["vendor_id"], 0)})
        elif similarity >= NAME_SIMILAR and not reasons:
            different = []
            if gst and v["gst_hst_number"] and v["gst_hst_number"] != gst:
                different.append("GST number")
            if bank_account and v["bank_account"] and v["bank_account"] != bank_account:
                different.append("bank account")
            if email_domain(email) and email_domain(v["ap_contact_email"]) != email_domain(email):
                different.append("email domain")
            results.append({"vendor_id": v["vendor_id"], "legal_name": v["legal_name"], "status": v["status"],
                            "kind": "lookalike", "reasons": [f"name {round(similarity * 100)}% similar"]
                            + [f"different {d}" for d in different],
                            "payments": paid.get(v["vendor_id"], 0)})
    return results


def lookalike_of_paid_vendor(conn, vendor: dict) -> dict | None:
    """The established vendor this one imitates, if any: a similar name we HAVE paid, with a different GST
    number and bank account, while this vendor has been paid less (usually never).

    Onboarding dates can't be trusted for this (the dataset's impostor V052 has an older onboarding date
    than the real firm V026), but payment history can: we know which account we've actually been paying.
    """
    mine = conn.execute("SELECT count(*) AS n FROM payments WHERE vendor_id = %s AND status IN ('settled', 'outstanding')",
                        (vendor["vendor_id"],)).fetchone()["n"]
    for s in similar_vendors(conn, name=vendor["legal_name"], gst=vendor["gst_hst_number"],
                             bank_account=vendor["bank_account"], email=vendor["ap_contact_email"],
                             exclude_id=vendor["vendor_id"]):
        if s["kind"] == "lookalike" and s["payments"] > mine and "different bank account" in s["reasons"]:
            return s
    return None
