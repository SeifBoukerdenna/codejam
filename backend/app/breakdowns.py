"""Show the math: the arithmetic behind an important number, as parts that add up to it.

The browser never adds money (CLAUDE.md), so when someone hovers a total, the parts come from here. They're built
with the same helpers the checks use (apply_rate, the PO balance from checks/context.py), so the tooltip and the
check's sentence can't disagree.

A breakdown is {"parts": [{"label", "cents"}], "total_label", "total_cents", "note"}, and the parts ALWAYS add up
to total_cents: when a printed number doesn't add up (Evergreen's total is $100 off), the gap becomes its own
part ("Not explained by the subtotal and tax"). The arithmetic on screen is then always true, and the problem is
visible as a line of it.
"""

from decimal import Decimal

from app.money import apply_rate, fmt

METHOD_WORDS = {"EFT": "Bank transfers", "CHEQUE": "Cheques", "CARD": "Cards"}


def breakdown(parts: list[tuple[str, int]], total_cents: int, total_label: str = "Total", note: str | None = None,
              gap_label: str = "Not explained") -> dict:
    rows = [{"label": label, "cents": cents} for label, cents in parts]
    gap = total_cents - sum(cents for _, cents in parts)
    if gap:
        rows.append({"label": gap_label, "cents": gap})
    return {"parts": rows, "total_label": total_label, "total_cents": total_cents, "note": note}


def top_parts(items: list[tuple[str, int]], keep: int = 4, rest: str = "{n} more") -> list[tuple[str, int]]:
    """The biggest few, then one "N more" line for the rest, so a tooltip stays readable."""
    items = sorted(items, key=lambda i: -abs(i[1]))
    if len(items) <= keep + 1:
        return items
    others = items[keep:]
    return items[:keep] + [(rest.format(n=len(others)), sum(c for _, c in others))]


def _qty(q) -> str:
    return f"{Decimal(q).normalize():f}"


def invoice_math(ctx) -> dict:
    """Every number on an invoice page that can be hovered: lines, subtotal, each tax, the total, the PO balance."""
    inv, cur = ctx["invoice"], ctx["invoice"]["currency"]
    out: dict = {"lines": {}, "taxes": {}, "subtotal": None, "total": None, "po": None, "po_id": None}

    # A line is quantity × unit price. Only worth showing when there's something to multiply (or it's wrong).
    for line in ctx["lines"]:
        expected = apply_rate(line["unit_price_cents"], Decimal(line["quantity"]))
        if Decimal(line["quantity"]) != 1 or expected != line["amount_cents"]:
            out["lines"][line["line_no"]] = breakdown(
                [(f"{_qty(line['quantity'])} × {fmt(line['unit_price_cents'], cur)}", expected)], line["amount_cents"],
                "Line amount", gap_label="Not explained by quantity × price")

    if inv["subtotal_cents"] is not None and ctx["lines"]:
        lines = [(f"{l['description'][:38]}", l["amount_cents"]) for l in ctx["lines"]]
        out["subtotal"] = breakdown(top_parts(lines, 5, "{n} more lines"), inv["subtotal_cents"], "Subtotal",
                                    gap_label="Not explained by the lines")

    # Each tax: its own rate × the base it applies to (PST: goods only). Whether it's the RIGHT tax for the
    # province is a check's sentence, not arithmetic.
    for tax in ctx["printed_taxes"]:
        code = ctx["tax_codes"].get(tax.get("code") or "")
        kind = "gst_hst" if tax.get("code") in ("HST13", "GST5") else "pst_qst"
        if not code or inv["subtotal_cents"] is None:
            continue
        goods = code["applies_to"] == "goods"
        base = ctx["goods_subtotal_cents"] if goods else inv["subtotal_cents"]
        expected = apply_rate(base, code["rate"])
        gap = tax["amount_cents"] - expected
        out["taxes"][kind] = breakdown(
            [(f"{tax['rate_pct']}% of {fmt(base, cur)}{' (goods only)' if goods else ''}", expected)], tax["amount_cents"],
            tax["label"], gap_label="Charged more than the rate" if gap > 0 else "Charged less than the rate")

    if inv["total_cents"] is not None and inv["subtotal_cents"] is not None:
        notes = []
        if inv["currency"] != "CAD" and inv["total_cad_cents"] is not None:
            notes.append(f"= {fmt(inv['total_cad_cents'])} at {inv['fx_rate_to_cad']} {inv['currency']}→CAD on "
                         f"{inv['invoice_date']:%b %-d}, the invoice date.")
        po, po_note = ctx["po"], None
        if po and not inv["is_credit_note"]:
            # Compared with tax included, like the P12 check (see CLAUDE.md, "PO balance compared on the total").
            left = po["remaining_cents"] - inv["total_cents"]
            po_note = (f"{po['po_id']} has {fmt(po['remaining_cents'])} left: "
                       + (f"this invoice is {fmt(-left)} over." if left < 0 else f"{fmt(left)} after this invoice."))
            notes.append(po_note)
        parts = [("Subtotal", inv["subtotal_cents"])] + [(f"{t['label']} {t['rate_pct']}%", t["amount_cents"])
                                                         for t in ctx["printed_taxes"]]
        out["total"] = breakdown(parts, inv["total_cents"], "Total", " ".join(notes) or None,
                                 gap_label="Not explained by the subtotal and tax")
        if po_note:
            out["po_id"] = po["po_id"]
            out["po"] = po_balance(po["po_id"], po["description"], po["total_amount_cents"],
                                   po["total_amount_cents"] - po["remaining_cents"], "Left before this invoice", po_note)
    return out


def po_balance(po_id: str, description: str, po_cents: int, invoiced_cents: int, total_label: str = "Left",
               note: str | None = None) -> dict:
    return breakdown([(f"{po_id} · {description[:30]}", po_cents), ("Already invoiced against it", -invoiced_cents)],
                     po_cents - invoiced_cents, total_label, note)


def payment_amount(invoice_total_cents: int, credit_cents: int, amount_cents: int) -> dict | None:
    """A payment smaller than its invoice because credit notes were deducted (credit_notes.py)."""
    if not credit_cents:
        return None
    return breakdown([("Invoice total", invoice_total_cents), ("Credit notes deducted", -credit_cents)], amount_cents,
                     "Paid", gap_label="Not explained")


def by_method(rows: list[dict], total_cents: int, note: str) -> dict:
    """Paid this year: bank transfers + cheques + cards."""
    return breakdown([(METHOD_WORDS.get(r["method"], r["method"]), r["cents"]) for r in rows], total_cents,
                     "Paid this year", note)


def paid_twice(recoveries: list[dict], still_open: bool) -> dict:
    """Money paid twice, by vendor: all of it (still_open=False) or only what we haven't got back yet."""
    by_vendor: dict[str, int] = {}
    for r in recoveries:
        if still_open and r["status"] == "recovered":
            continue
        by_vendor[r["vendor_name"]] = by_vendor.get(r["vendor_name"], 0) + r["overpaid_cad_cents"]
    back = sum(r["overpaid_cad_cents"] for r in recoveries if r["status"] == "recovered")
    return breakdown(top_parts(list(by_vendor.items()), 4, "{n} more vendors"), sum(by_vendor.values()),
                     "Still to get back" if still_open else "Paid twice",
                     f"Already got back: {fmt(back)}." if back else None)


def tax_at_risk(rows: list[dict]) -> dict:
    """Tax we can't claim back: by invoice, biggest first."""
    by_invoice: dict[str, int] = {}
    for r in rows:
        key = f"{r['vendor_name'] or 'Unknown vendor'} {r['vendor_invoice_number'] or r['invoice_id']}"
        by_invoice[key] = by_invoice.get(key, 0) + r["at_risk_cents"]
    return breakdown(top_parts(list(by_invoice.items()), 4, "{n} more invoices"), sum(by_invoice.values()),
                     "At risk", "Fix the invoice before paying it, and the credit can be claimed." if rows else None)


def bank_in_question(statement: dict) -> dict:
    """Bank debits nobody has explained yet, by kind, plus those we asked the bank about and are waiting on."""
    groups: dict[str, list[int]] = {}
    for line in statement["lines"]:
        if line["todo"] == "ask_bank":
            groups.setdefault(line["title"], []).append(line["at_stake_cents"])
        elif line["resolution"] == "asked_bank":
            groups.setdefault("Asked the bank, no answer yet", []).append(line["at_stake_cents"])
    parts = [(f"{title} ({len(c)})" if len(c) > 1 else title, sum(c)) for title, c in groups.items()]
    return breakdown(parts, statement["unexplained_cents"] + statement["waiting_cents"], "In question",
                     gap_label="Other")
