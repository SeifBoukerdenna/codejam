"""Run every check on one invoice. The list below IS the validation policy: read it top to bottom."""

from app.checks import CheckResult
from app.checks.amounts import check_amounts
from app.checks.context import build_context
from app.checks.contracts import check_contract
from app.checks.credit_notes import check_credit_note
from app.checks.dates import check_dates
from app.checks.duplicates import check_duplicates
from app.checks.po import check_po
from app.checks.splits import check_split
from app.checks.tax import check_tax
from app.checks.vendor import check_vendor

CHECKS = [
    check_vendor,       # known, approved, not a look-alike, bank details unchanged / verified
    check_duplicates,   # seen before, or already paid by card
    check_amounts,      # lines × qty, lines vs subtotal, subtotal + tax vs total, tax vs rate
    check_tax,          # right tax for the delivery province
    check_dates,        # not future-dated, not stale
    check_contract,     # fixed fee, fuel surcharge cap, hourly cap, expiry, monthly limit
    check_po,           # matched to an open PO with enough left (P12, P13)
    check_split,        # split to stay under the $10k approval limit
    check_credit_note,  # credit notes are deducted, never paid
]


def run_checks(conn, invoice_id: str) -> tuple[dict, list[CheckResult]]:
    ctx = build_context(conn, invoice_id)
    results = [r for check in CHECKS for r in check(ctx)]
    return ctx, results
