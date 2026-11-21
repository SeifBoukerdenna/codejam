"""Is this a vendor we know, can pay, and does the invoice's printed identity match our records?"""

from app.checks import CheckResult, block, info, warn
from app.extraction.extract import well_formed
from app.money import fmt


def _and_list(items: list[str]) -> str:
    """['GST number', 'bank account', 'email domain'] -> 'GST number, bank account and email domain'."""
    return items[0] if len(items) == 1 else f"{', '.join(items[:-1])} and {items[-1]}"


def check_vendor(ctx) -> list[CheckResult]:
    vendor, printed = ctx["vendor"], ctx["printed"]
    name = printed.get("vendor_name") or "This vendor"
    if vendor is None:
        return [block("VENDOR_NOT_IN_MASTER",
                      f"{name} isn't in our vendor list. Onboard it (and verify its bank details) before this "
                      f"invoice can go any further.")]

    results = []
    if vendor["status"] == "on_hold":
        results.append(block("VENDOR_ON_HOLD", f"{vendor['legal_name']} is on hold"
                             + (f": {vendor['status_reason']}" if vendor.get("status_reason") else "")
                             + ". Nothing can be approved or paid for it."))
    elif vendor["status"] == "pending_review":
        results.append(warn("VENDOR_PENDING_REVIEW",
                            f"{vendor['legal_name']} hasn't been approved as a vendor yet. The invoice gets an extra "
                            f"finance manager approval (P05) and can't be paid until the vendor is approved."))

    if ctx["lookalike"]:
        other = ctx["lookalike"]
        differs = [r.replace("different ", "") for r in other["reasons"] if r.startswith("different")]
        results.append(block("VENDOR_LOOKALIKE",
                             f"“{vendor['legal_name']}” looks like “{other['legal_name']}”, a vendor we've paid "
                             f"{other['payments']} times, but with a different {_and_list(differs)}. This may be an "
                             f"impersonation. Confirm with {other['legal_name']} using the contact details we already "
                             f"have.", lookalike_of=other["vendor_id"]))

    if ctx["pending_bank_change"]:
        change = ctx["pending_bank_change"]
        results.append(block("BANK_CHANGE_UNVERIFIED",
                             f"The bank account for {vendor['legal_name']} was changed on {change['changed_at']:%B %-d, %Y} "
                             f"({change['request_channel'].replace('_', ' ')}) and nobody has confirmed it by calling "
                             f"the vendor. Hold until someone calls them at the number on file from before the change.",
                             change_id=change["change_id"]))

    # The GST/HST number printed on the invoice vs. our records.
    gst = printed.get("vendor_gst")
    if gst and not well_formed("vendor_gst", gst):
        results.append(warn("GST_NUMBER_UNREADABLE",
                            f"The GST/HST number on the invoice reads “{gst}”, which isn't a valid number (9 digits, RT, "
                            f"4 digits). Probably an OCR misread; check the original."))
    elif gst and vendor["gst_hst_number"] and gst != vendor["gst_hst_number"]:
        results.append(block("GST_NUMBER_MISMATCH",
                             f"The invoice shows GST/HST number {gst}, but our records for {vendor['legal_name']} have "
                             f"{vendor['gst_hst_number']}."))
    charged_tax = (ctx["invoice"]["gst_hst_cents"] or 0) + (ctx["invoice"]["pst_qst_cents"] or 0)
    inv = ctx["invoice"]
    if not gst and charged_tax and vendor["country"] == "CA" and inv["source"] != "history":
        results.append(warn("GST_NUMBER_MISSING",
                            f"Tax is charged but no GST/HST number is printed, so we can't claim the "
                            f"{fmt(inv['gst_hst_cents'], inv['currency'])} back from the CRA.",
                            at_risk_cents=inv["gst_hst_cents"] or 0, fix="Ask the vendor for their GST/HST number"))
    # Only a QST registrant may charge QST, and Quebec only refunds it with the vendor's QST number on file.
    qst_charged = any(t["code"] == "QST9975" for t in ctx["printed_taxes"])
    if (qst_charged and not printed.get("vendor_qst") and not vendor["qst_number"] and inv["source"] != "history"):
        results.append(warn("QST_NUMBER_MISSING",
                            f"QST of {fmt(inv['pst_qst_cents'], inv['currency'])} is charged, but there's no QST number on "
                            f"the invoice or on file, so we can't claim it back from Revenu Québec.",
                            at_risk_cents=inv["pst_qst_cents"] or 0, fix="Ask the vendor for their QST number"))

    # Where the invoice asks us to send money vs. the bank account on file.
    acct, transit, inst = printed.get("bank_account"), printed.get("bank_transit"), printed.get("bank_institution")
    if acct and vendor["bank_account"]:
        if acct != vendor["bank_account"] and acct[-4:] in ctx["previous_accounts_last4"]:
            results.append(info("BANK_DETAILS_PREVIOUS_ACCOUNT",
                                f"The invoice still shows the vendor's previous account ••••{acct[-4:]}. Payment goes to "
                                f"the verified account on file, ••••{vendor['bank_account'][-4:]}."))
        elif acct != vendor["bank_account"]:
            results.append(block("BANK_DETAILS_MISMATCH",
                                 f"The invoice asks for payment to account ••••{acct[-4:]}, but the account on file is "
                                 f"••••{vendor['bank_account'][-4:]}. Never pay to new details printed on an invoice."))
        elif transit and transit != vendor["bank_transit"]:
            results.append(warn("BANK_TRANSIT_MISMATCH",
                                f"Transit on the invoice is “{transit}” but on file it's {vendor['bank_transit']} "
                                f"(same account number). Check the original document."))
        elif inst and inst != vendor["bank_institution"]:
            results.append(warn("BANK_INSTITUTION_MISMATCH",
                                f"Institution on the invoice is {inst} but on file it's {vendor['bank_institution']}."))

    if not results and ctx["invoice"]["source"] != "history":
        results.append(info("VENDOR_OK", f"{vendor['legal_name']} is an approved vendor; identity details match."))
    return results
