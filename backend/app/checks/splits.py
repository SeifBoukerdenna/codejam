"""Split invoices: several invoices from one vendor within a few days, each under the department manager's
$10,000 limit, adding up to more than it. A classic way to dodge the finance manager's approval (P02)."""

from app.checks import CheckResult, warn
from app.money import fmt

SPLIT_WINDOW_DAYS = 4


def find_split_group(invoice: dict, others: list[dict], limit_cents: int) -> list[dict]:
    """Invoices (including this one) from the same vendor within the window, each at or under the limit."""
    if not invoice["invoice_date"] or invoice["is_credit_note"] or (invoice["total_cad_cents"] or 0) > limit_cents:
        return []
    group = [o for o in others
             if o["invoice_date"] and not o["is_credit_note"]
             and abs((o["invoice_date"] - invoice["invoice_date"]).days) <= SPLIT_WINDOW_DAYS
             and 0 < (o["total_cad_cents"] or 0) <= limit_cents]
    combined = sum(o["total_cad_cents"] for o in group) + invoice["total_cad_cents"]
    return group if group and combined > limit_cents else []


def check_split(ctx) -> list[CheckResult]:
    inv = ctx["invoice"]
    limit = ctx["thresholds"]["P01"]
    group = find_split_group(inv, ctx["vendor_invoices"], limit)
    if not group:
        return []
    combined = sum(o["total_cad_cents"] for o in group) + inv["total_cad_cents"]
    names = ", ".join(f"#{o['vendor_invoice_number']}" for o in group)
    return [warn("SPLIT_INVOICE",
                 f"{len(group) + 1} invoices from this vendor within {SPLIT_WINDOW_DAYS} days (this one and {names}) "
                 f"add up to {fmt(combined)}, each under the {fmt(limit)} limit. Possibly split to avoid finance "
                 f"manager approval, so a finance manager approves this one (P02).",
                 related=[o["invoice_id"] for o in group], combined_cents=combined)]
