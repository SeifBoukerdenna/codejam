"""Purchase order matching (P12, P13).

None of the incoming invoices prints a PO number, so the invoice is matched to the vendor's open PO.
DECISION: the PO balance is compared on the invoice TOTAL including tax (P12 says "total"); see CLAUDE.md.
"""

from app.checks import CheckResult, block, info, warn
from app.money import fmt


def check_po(ctx) -> list[CheckResult]:
    inv, vendor, po = ctx["invoice"], ctx["vendor"], ctx["po"]
    if vendor is None or inv["is_credit_note"]:
        return []
    if po is None:
        if vendor["requires_po"]:
            return [block("PO_MISSING",
                          f"{vendor['legal_name']} can only be paid against a purchase order, and there's no open PO "
                          f"for it. Hold until someone raises a PO (P13).")]
        return []
    remaining = po["remaining_cents"]
    total = inv["total_cents"] or 0
    if total > remaining:
        return [warn("PO_OVER_BALANCE",
                     f"Matched to {po['po_id']} ({po['description']}), which has {fmt(remaining)} left of "
                     f"{fmt(po['total_amount_cents'])}. This invoice is {fmt(total)} with tax, "
                     f"{fmt(total - remaining)} over, so a finance manager must approve it (P12).",
                     po_id=po["po_id"], over_cents=total - remaining)]
    return [info("PO_MATCHED", f"Matched to {po['po_id']} ({po['description']}). {fmt(remaining - total)} will be "
                 f"left on the PO after this invoice.", po_id=po["po_id"])]
