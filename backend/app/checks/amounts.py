"""Arithmetic: each line, the lines vs the subtotal, the subtotal + tax vs the total, each tax vs its rate."""

from decimal import Decimal

from app.checks import CheckResult, block, info
from app.money import apply_rate, fmt

TOLERANCE_CENTS = 1  # invoices round per line or per total; a 1-cent difference is rounding, not an error


def check_amounts(ctx) -> list[CheckResult]:
    inv, lines = ctx["invoice"], ctx["lines"]
    cur = inv["currency"]
    results = []

    for line in lines:
        expected = apply_rate(line["unit_price_cents"], Decimal(line["quantity"]))
        if abs(expected - line["amount_cents"]) > TOLERANCE_CENTS:
            qty = Decimal(line["quantity"]).normalize()
            results.append(block("LINE_AMOUNT_WRONG",
                                 f"Line “{line['description']}”: {qty} × {fmt(line['unit_price_cents'], cur)} = "
                                 f"{fmt(expected, cur)}, but the invoice says {fmt(line['amount_cents'], cur)}.",
                                 line_no=line["line_no"], expected_cents=expected))

    lines_sum = sum(line["amount_cents"] for line in lines)
    if inv["subtotal_cents"] is not None and abs(lines_sum - inv["subtotal_cents"]) > TOLERANCE_CENTS:
        results.append(block("LINES_DONT_ADD_UP",
                             f"The lines add up to {fmt(lines_sum, cur)}, but the subtotal says "
                             f"{fmt(inv['subtotal_cents'], cur)}."))

    taxes = (inv["gst_hst_cents"] or 0) + (inv["pst_qst_cents"] or 0)
    if inv["subtotal_cents"] is not None and inv["total_cents"] is not None:
        expected_total = inv["subtotal_cents"] + taxes
        if abs(expected_total - inv["total_cents"]) > TOLERANCE_CENTS:
            results.append(block("TOTAL_DOESNT_ADD_UP",
                                 f"Subtotal {fmt(inv['subtotal_cents'], cur)} + tax {fmt(taxes, cur)} = "
                                 f"{fmt(expected_total, cur)}, but the total says {fmt(inv['total_cents'], cur)} "
                                 f"({fmt(inv['total_cents'] - expected_total, cur)} off).",
                                 difference_cents=inv["total_cents"] - expected_total))

    # Each printed tax vs. its own rate × the base it applies to. (Whether it's the RIGHT tax for the
    # province is tax.py's job.)
    for tax in ctx["printed_taxes"]:
        code = ctx["tax_codes"].get(tax.get("code") or "")
        if not code or inv["subtotal_cents"] is None:
            continue
        base = ctx["goods_subtotal_cents"] if code["applies_to"] == "goods" else inv["subtotal_cents"]
        if base == 0:
            continue   # e.g. PST on an invoice with no goods: the wrong tax entirely, reported by tax.py
        expected = apply_rate(base, code["rate"])
        if abs(expected - tax["amount_cents"]) > TOLERANCE_CENTS:
            results.append(block("TAX_AMOUNT_WRONG",
                                 f"{tax['label']} at {tax['rate_pct']}% of {fmt(base, cur)} should be {fmt(expected, cur)}, "
                                 f"but the invoice charges {fmt(tax['amount_cents'], cur)}.", tax_code=code["code"]))

    if not results and inv["source"] != "history":
        results.append(info("AMOUNTS_OK", "Lines, subtotal, taxes and total all add up."))
    return results
