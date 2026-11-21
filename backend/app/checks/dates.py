"""Dates make sense: not in the future, not stale, due after issued. "Today" is the configured business date."""

from datetime import date

from app.checks import CheckResult, block, warn

STALE_AFTER_DAYS = 120  # DECISION: older than ~4 months is unusual for a monthly-billing vendor; a person looks


def check_dates(ctx) -> list[CheckResult]:
    inv, today = ctx["invoice"], ctx["today"]
    invoice_date: date | None = inv["invoice_date"]
    results = []
    if invoice_date is None:
        return [warn("INVOICE_DATE_MISSING", "The invoice has no date we could read. Fill it in.")]
    if invoice_date > today:
        results.append(block("FUTURE_DATED",
                             f"The invoice is dated {invoice_date:%B %-d, %Y}, which is in the future (today is "
                             f"{today:%B %-d, %Y}). Hold it until that date or ask the vendor to reissue it."))
    age = (today - invoice_date).days
    if age > STALE_AFTER_DAYS:
        results.append(warn("STALE_INVOICE",
                            f"The invoice is dated {invoice_date:%B %-d, %Y}, {age} days ago. Check it wasn't already "
                            f"paid or replaced before paying it now."))
    if inv["due_date"] and inv["due_date"] < invoice_date:
        results.append(warn("DUE_BEFORE_ISSUED", "The due date is before the invoice date."))
    return results
