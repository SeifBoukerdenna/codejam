"""Is it the right tax for where the goods or services were delivered (the Bill-to province)?

Rules as given by the brief (not tax advice):
  ON: HST 13%          QC: GST 5% + QST 9.975% on the pre-tax amount
  AB and others: GST 5%   BC: GST 5% + PST 7% on GOODS only (services pay no PST)
  Foreign vendors and insurance premiums: no Canadian tax.
"""

from app.checks import CheckResult, block, info, warn
from app.money import apply_rate, fmt

PROVINCE_NAMES = {"ON": "Ontario", "QC": "Quebec", "BC": "British Columbia", "AB": "Alberta", "MB": "Manitoba",
                  "SK": "Saskatchewan", "NS": "Nova Scotia", "NB": "New Brunswick", "NL": "Newfoundland",
                  "PE": "Prince Edward Island"}


def expected_codes(ctx) -> tuple[set[str], str]:
    """Which tax codes should appear on this invoice, and the reason in words."""
    vendor, inv = ctx["vendor"], ctx["invoice"]
    province = inv["ship_to_province"]
    if vendor and vendor["country"] != "CA":
        return set(), "the vendor is outside Canada, so no Canadian tax applies"
    if vendor and vendor["category"] == "Insurance":
        return set(), "insurance premiums are exempt"
    if vendor and not vendor["gst_hst_number"] and not ctx["printed"].get("vendor_gst"):
        return set(), "the vendor has no GST number, so it shouldn't charge GST"
    if province == "ON":
        return {"HST13"}, "delivered to Ontario: 13% HST"
    if province == "QC":
        return {"GST5", "QST9975"}, "delivered to Quebec: 5% GST + 9.975% QST"
    if province == "BC":
        if ctx["goods_subtotal_cents"]:
            return {"GST5", "PST7_BC"}, "delivered to British Columbia: 5% GST, plus 7% PST on the goods"
        return {"GST5"}, "delivered to British Columbia: 5% GST (these are services, so no PST)"
    return {"GST5"}, f"delivered to {PROVINCE_NAMES.get(province, province)}: 5% GST"


def check_tax(ctx) -> list[CheckResult]:
    inv = ctx["invoice"]
    cur = inv["currency"]
    if inv["ship_to_province"] is None:
        return [warn("TAX_PROVINCE_UNKNOWN", "We couldn't tell which province this was delivered to, so we can't "
                     "check the tax. Fill in the Bill-to province.")]
    expected, why = expected_codes(ctx)
    charged = {t["code"]: t for t in ctx["printed_taxes"] if t.get("code")}
    unknown = [t for t in ctx["printed_taxes"] if not t.get("code")]
    codes = ctx["tax_codes"]
    results = []

    def amount_for(code: str) -> int:
        base = ctx["goods_subtotal_cents"] if codes[code]["applies_to"] == "goods" else inv["subtotal_cents"]
        return apply_rate(base, codes[code]["rate"])

    missing = expected - set(charged)
    extra = set(charged) - expected

    # Most common real mistake: the Ontario rate used outside Ontario. Report it as one problem, not two.
    if "HST13" in extra and "GST5" in missing:
        results.append(block("WRONG_TAX_FOR_PROVINCE",
                             f"Charged 13% HST ({fmt(charged['HST13']['amount_cents'], cur)}), but {why}. "
                             f"The correct GST is {fmt(amount_for('GST5'), cur)}.",
                             overcharged_cents=charged["HST13"]["amount_cents"] - amount_for("GST5"),
                             at_risk_cents=charged["HST13"]["amount_cents"] - amount_for("GST5"),
                             fix="Ask for a corrected invoice with 5% GST"))
        extra.discard("HST13")
        missing.discard("GST5")
    if "PST7_BC" in extra and inv["ship_to_province"] == "BC":
        results.append(block("PST_ON_SERVICES",
                             f"Charged 7% BC PST ({fmt(charged['PST7_BC']['amount_cents'], cur)}) on services. "
                             f"In BC, PST applies to goods only. PST is also not recoverable, so this is a real cost.",
                             overcharged_cents=charged["PST7_BC"]["amount_cents"],
                             at_risk_cents=charged["PST7_BC"]["amount_cents"],
                             fix="Ask for a corrected invoice without PST"))
        extra.discard("PST7_BC")
    for code in sorted(missing):
        results.append(block("TAX_MISSING",
                             f"No {codes[code]['description']} was charged, but {why}. Expected "
                             f"{fmt(amount_for(code), cur)}. Ask the vendor for a corrected invoice before paying it.", tax_code=code, expected_cents=amount_for(code)))
    for code in sorted(extra):
        results.append(block("UNEXPECTED_TAX",
                             f"Charged {codes[code]['description']} ({fmt(charged[code]['amount_cents'], cur)}), "
                             f"but {why}.", tax_code=code, at_risk_cents=charged[code]["amount_cents"],
                             fix="Ask for a corrected invoice without this tax"))
    for tax in unknown:
        results.append(warn("TAX_RATE_UNUSUAL",
                            f"Charged {tax['label']} at {tax['rate_pct']}%, which isn't a rate we use. Check it."))

    if not results and inv["source"] != "history":
        results.append(info("TAX_OK", f"Tax is right: {why}."))
    return results
