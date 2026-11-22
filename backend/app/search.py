"""Cmd+K search: find an invoice by its number, vendor or amount, and a vendor by name, id or GST number.

Plain word matching, explainable line by line: EVERY word typed must match something on the row, and each kind of
match is worth points, so "orion 279" ranks Orion's invoice 279 first and "961" finds both 000961 and AP-00393.
Invoice numbers are compared the way the duplicate check compares them (normalize_invoice_number: "583" finds
FA-000583), so search and duplicate detection agree on what "the same number" means.

DECISION: the ~500 invoices are scored in Python, not in SQL. At Harborline's 50 invoices a month that stays
instant for years, and the rules read as code. Rejected: Postgres full-text search, which doesn't understand
invoice numbers or amounts. At a bigger scale: a pg_trgm index on the number and vendor name.
"""

import re

from app.checks.duplicates import normalize_invoice_number
from app.vendor_match import normalize_name

INVOICE_LIMIT = 8
VENDOR_LIMIT = 5

AMOUNT = re.compile(r"^\$?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?$")


def amount_range(word: str) -> tuple[int, int] | None:
    """The amounts, in cents, a typed word can mean: "$6,452.30" is exactly 645230; "6452" is $6,452.00 to $6,452.99."""
    m = AMOUNT.match(word)
    if not m:
        return None
    dollars = int(m.group(1).replace(",", ""))
    if m.group(2):
        cents = dollars * 100 + int(m.group(2)[1:].ljust(2, "0"))
        return cents, cents
    return dollars * 100, dollars * 100 + 99


def _name_words(name: str | None) -> list[str]:
    return normalize_name(name or "").split()


def _starts_a_word(word: str, name: str | None) -> bool:
    typed = normalize_name(word)
    return bool(typed) and any(w.startswith(typed) for w in _name_words(name))


def invoice_points(word: str, inv: dict) -> int:
    """How well one typed word matches one invoice; 0 = it doesn't."""
    number = inv["vendor_invoice_number"] or ""
    key = normalize_invoice_number(word)
    amounts = amount_range(word)
    if word.upper() == inv["invoice_id"]:
        return 100
    if key and key == normalize_invoice_number(number):
        return 90
    if amounts and any(c is not None and amounts[0] <= abs(c) <= amounts[1] for c in (inv["total_cents"], inv["total_cad_cents"])):
        return 70
    if len(word) >= 3 and word.upper() in number.upper():
        return 60
    if key and key == normalize_invoice_number(inv["invoice_id"]):
        return 50
    if _starts_a_word(word, inv["vendor_name"]):
        return 40
    return 0


def vendor_points(word: str, vendor: dict) -> int:
    if word.upper() == vendor["vendor_id"]:
        return 100
    digits = re.sub(r"\D", "", word)
    if len(digits) >= 4 and digits in re.sub(r"\D", "", vendor["gst_hst_number"] or ""):
        return 60
    if _starts_a_word(word, vendor["legal_name"]):
        return 40
    return 0


def _rank(words: list[str], rows: list[dict], points) -> list[tuple[int, dict]]:
    ranked = []
    for row in rows:
        scores = [points(w, row) for w in words]
        if all(scores):
            ranked.append((sum(scores), row))
    return ranked


def search(query: str, invoices: list[dict], vendors: list[dict]) -> dict:
    words = query.split()[:6]
    if not words:
        return {"invoices": [], "vendors": []}
    found = _rank(words, invoices, invoice_points)
    # Best match first; among equals, the newest invoice (that's the one people are usually looking for).
    found.sort(key=lambda s: (s[0], str(s[1]["invoice_date"] or "")), reverse=True)
    vendor_hits = _rank(words, vendors, vendor_points)
    vendor_hits.sort(key=lambda s: (-s[0], s[1]["legal_name"]))
    return {"invoices": [row for _, row in found[:INVOICE_LIMIT]],
            "vendors": [row for _, row in vendor_hits[:VENDOR_LIMIT]]}
