"""Credit notes are money the vendor owes us. They are never paid out; once approved they are deducted from
the next payment to that vendor (see workflow/payments.py)."""

from app.checks import STATUS_WORDS, CheckResult, info
from app.checks.duplicates import normalize_invoice_number
from app.money import fmt


def check_credit_note(ctx) -> list[CheckResult]:
    inv = ctx["invoice"]
    if not inv["is_credit_note"]:
        return []
    vendor_name = ctx["vendor"]["legal_name"] if ctx["vendor"] else "this vendor"
    results = [info("CREDIT_NOTE",
                    f"Credit note for {fmt(-(inv['total_cents'] or 0), inv['currency'])}. It won't be paid out: once "
                    f"approved it's deducted from the next payment to {vendor_name}.")]

    ref = ctx["printed"].get("credit_note_ref")
    originals = [o for o in ctx["vendor_invoices"] if not o["is_credit_note"]]
    match = None
    if ref:
        match = next((o for o in originals
                      if normalize_invoice_number(o["vendor_invoice_number"]) == normalize_invoice_number(ref)), None)
    if match is None:
        match = next((o for o in originals if o["total_cents"] == -(inv["total_cents"] or 0)), None)
        if match:
            results.append(info("CREDIT_NOTE_REVERSES", f"It exactly reverses invoice #{match['vendor_invoice_number']} "
                                f"({match['invoice_id']}, {STATUS_WORDS.get(match['status'], match['status'])}).", original=match["invoice_id"]))
    else:
        results.append(info("CREDIT_NOTE_REVERSES", f"It refers to invoice #{match['vendor_invoice_number']} "
                            f"({match['invoice_id']}, {STATUS_WORDS.get(match['status'], match['status'])}).", original=match["invoice_id"]))
    return results
