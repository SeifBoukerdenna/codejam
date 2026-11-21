"""Have we seen (or paid) this invoice before?

DECISION (duplicate key): same vendor, or a vendor we know is the same company entered twice, plus the same
normalized invoice number. Normalizing keeps only the digits and drops leading zeros, so "FA-000583" and
"583", or "000903-A" and "000903", are the same invoice. Credit notes are only compared with credit notes.
Same vendor + same amount within 14 days under a different number is only a warning (a wider window flags every
monthly subscription, which bills the same amount every ~30 days).
An EMPLOYEE card charge from the vendor for the same amount near the invoice date means it was already paid by
card. Brim virtual-card payments are AP's own payments of a specific invoice (memo "AP payment AP-00370"), so a
re-sent invoice is caught by its number instead, and the message says it was paid by card.
"""

import re

from app.checks import STATUS_WORDS, CheckResult, block, warn
from app.money import fmt
from app.vendor_match import normalize_name

SAME_AMOUNT_WINDOW_DAYS = 14
CARD_WINDOW_DAYS = 30


def normalize_invoice_number(number: str | None) -> str:
    if not number:
        return ""
    digits = re.sub(r"\D", "", number)
    return digits.lstrip("0") or digits or re.sub(r"[^A-Z0-9]", "", number.upper())


def _describe(other: dict) -> str:
    status = STATUS_WORDS.get(other["status"], other["status"].replace("_", " "))
    return f"{other['invoice_id']} (#{other['vendor_invoice_number']}, {fmt(other['total_cents'], other['currency'])}, {status})"


def check_duplicates(ctx) -> list[CheckResult]:
    inv = ctx["invoice"]
    key = normalize_invoice_number(inv["vendor_invoice_number"])
    results = []

    same_number = [o for o in ctx["vendor_invoices"]
                   if key and normalize_invoice_number(o["vendor_invoice_number"]) == key
                   and o["is_credit_note"] == inv["is_credit_note"]]
    if same_number:
        other = same_number[0]
        reformatted = other["vendor_invoice_number"] != inv["vendor_invoice_number"]
        results.append(block("DUPLICATE_INVOICE",
                             f"Duplicate of {_describe(other)}"
                             + (f". Same invoice, number written differently (#{inv['vendor_invoice_number']} vs "
                                f"#{other['vendor_invoice_number']})." if reformatted else ".")
                             + (" Paid by card." if other.get("paid_by_card") else ""),
                             duplicate_of=other["invoice_id"]))

    if not same_number and inv["invoice_date"] and inv["total_cents"]:
        for o in ctx["vendor_invoices"]:
            if (o["total_cents"] == inv["total_cents"] and o["invoice_date"]
                    and abs((o["invoice_date"] - inv["invoice_date"]).days) <= SAME_AMOUNT_WINDOW_DAYS):
                results.append(warn("POSSIBLE_DUPLICATE",
                                    f"Same vendor and same amount as {_describe(o)}, dated "
                                    f"{o['invoice_date']:%b %-d}. Check it's really a different invoice.",
                                    duplicate_of=o["invoice_id"]))
                break

    for txn in ctx["card_matches"]:
        if inv["invoice_date"] and abs((txn["posted_date"] - inv["invoice_date"]).days) <= CARD_WINDOW_DAYS:
            card = f"{txn['cardholder_name']}'s employee card"
            results.append(block("ALREADY_PAID_BY_CARD",
                                 f"Already paid on {card}: {txn['merchant_descriptor']}, "
                                 f"{fmt(txn['amount_cad_cents'])} on {txn['posted_date']:%b %-d} ({txn['txn_id']}). "
                                 f"Paying this invoice too would pay it twice.", txn_id=txn["txn_id"]))
            break
    return results


def card_descriptor_matches(vendor_name: str, descriptor: str) -> bool:
    """Card statements show a shortened, upper-case name ("CLOUDBARN SOFTWARE INC", "PAPER TRAIL OFFICE").
    Match when the vendor's first significant word starts the descriptor and its second word (if any) appears."""
    vendor_words = normalize_name(vendor_name).split()
    desc_words = normalize_name(descriptor).split()
    if not vendor_words or not desc_words or desc_words[0] != vendor_words[0]:
        return False
    return len(vendor_words) < 2 or any(w.startswith(vendor_words[1][:5]) for w in desc_words[1:])

