"""Does the invoice respect the vendor's contract: still valid, fixed fee, hourly cap, fuel surcharge cap,
monthly not-to-exceed?"""

import re
from decimal import Decimal

from app.checks import CheckResult, block, warn
from app.money import fmt

FUEL_RE = re.compile(r"fuel\s+surcharge|surcharge\s+(?:de\s+)?carburant", re.I)
PCT_RE = re.compile(r"\((\d+(?:[.,]\d+)?)\s*%\)")


def check_contract(ctx) -> list[CheckResult]:
    contract, inv, lines = ctx["contract"], ctx["invoice"], ctx["lines"]
    if contract is None or inv["is_credit_note"]:
        return []
    cur = inv["currency"]
    cid = contract["contract_id"]
    results = []

    if inv["invoice_date"] and contract["end_date"] < inv["invoice_date"]:
        results.append(block("CONTRACT_EXPIRED",
                             f"Contract {cid} ({contract['description']}) ended on {contract['end_date']:%B %-d, %Y}, "
                             f"before this invoice ({inv['invoice_date']:%B %-d, %Y}). There's no agreement covering "
                             f"this work; it needs a renewed contract or a one-off approval.", contract_id=cid))

    if contract["billing_type"] == "fixed_monthly" and contract["monthly_fee_cents"] is not None:
        fee = contract["monthly_fee_cents"]
        if inv["subtotal_cents"] is not None and inv["subtotal_cents"] > fee:
            results.append(block("OVER_FIXED_FEE",
                                 f"Billed {fmt(inv['subtotal_cents'], cur)} before tax, but contract {cid} is a fixed "
                                 f"{fmt(fee, contract['currency'])} per month ({fmt(inv['subtotal_cents'] - fee, cur)} "
                                 f"more). Anything beyond the fee needs its own approval or a corrected invoice.",
                                 contract_id=cid, over_cents=inv["subtotal_cents"] - fee))

    cap = contract["fuel_surcharge_cap_pct"]
    if cap is not None:
        freight = sum(l["amount_cents"] for l in lines if not FUEL_RE.search(l["description"]))
        for line in lines:
            if not FUEL_RE.search(line["description"]):
                continue
            printed = PCT_RE.search(line["description"])
            pct = Decimal(printed.group(1).replace(",", ".")) if printed else (
                (Decimal(line["amount_cents"]) * 100 / freight).quantize(Decimal("0.01")) if freight else Decimal(0))
            if pct > cap:
                allowed = freight * cap / 100
                results.append(block("FUEL_SURCHARGE_OVER_CAP",
                                     f"Fuel surcharge is {pct}%, but contract {cid} caps it at {cap.normalize()}%. "
                                     f"At the cap it would be about {fmt(int(allowed), cur)}, not "
                                     f"{fmt(line['amount_cents'], cur)}.", contract_id=cid, pct=str(pct)))

    rate_cap = contract["hourly_rate_cap_cents"]
    if rate_cap is not None:
        for line in lines:
            # Hourly work is billed as hours × rate; a quantity of 1 is a flat item, not hours.
            if Decimal(line["quantity"]) > 1 and line["unit_price_cents"] > rate_cap:
                results.append(block("HOURLY_RATE_OVER_CAP",
                                     f"“{line['description']}” is billed at {fmt(line['unit_price_cents'], cur)}/hour, "
                                     f"above the {fmt(rate_cap, cur)}/hour cap in contract {cid}.", contract_id=cid))

    limit = contract["not_to_exceed_monthly_cents"]
    if limit is not None and inv["subtotal_cents"] is not None:
        month_total = ctx["vendor_month_to_date_cents"] + inv["subtotal_cents"]
        if month_total > limit:
            results.append(warn("MONTHLY_LIMIT_EXCEEDED",
                                f"With this invoice, {inv['invoice_date']:%B} billing from this vendor reaches "
                                f"{fmt(month_total, cur)} before tax, over the {fmt(limit, cur)} monthly limit in "
                                f"contract {cid}.", contract_id=cid))
    return results
