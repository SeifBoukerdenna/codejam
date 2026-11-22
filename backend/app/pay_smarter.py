"""Pay smarter: for each approved invoice, how and when to pay it, in words. Read-only advice: it changes nothing,
a person still prepares the payment (and P09-P11 still decide who releases it).

The rules, in order (the first that applies wins):
  1. The vendor's early-payment discount window is open ("2/10 net 30" = 2% off if paid within 10 days):
     pay by the last discount day. The discount is 2% of the PRE-TAX subtotal, which is how every discount in the
     dataset's history was taken (Paper Trail AP-00015: 2% of $1,856.50 = $37.13, tax not discounted).
  2. The vendor accepts cards: a Brim single-use card on the due date. Locked to the vendor and the exact amount,
     so there are no bank details to swap, and the cash stays with us until then.
  3. Otherwise the vendor's usual method (bank transfer or cheque) on the due date, not earlier.
DECISION: no card rewards rate is assumed. The brief gives none and inventing one would make every number that
depends on it fiction. It's a setting (CARD_REWARDS_RATE, default 0, shown as "your rate"); at 0 nothing is shown.
"""

import re
from datetime import date, timedelta
from decimal import Decimal

from app import breakdowns, config
from app.money import apply_rate, fmt

TERMS = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*/\s*(\d+)\s+net\s+(\d+)\s*$", re.I)
METHOD_WORDS = {"EFT": "bank transfer", "CHEQUE": "cheque", "CARD": "Brim single-use card"}


def discount_terms(text: str | None) -> tuple[Decimal, int] | None:
    """'2/10 net 30' -> (0.02, 10). Anything else -> None (no discount)."""
    m = TERMS.match(text or "")
    return (Decimal(m.group(1)) / 100, int(m.group(2))) if m else None


def _pct(rate: Decimal) -> str:
    return f"{(rate * 100).normalize():f}%"          # 0.02 -> "2%"


def _day(d: date, today: date) -> str:
    return f"{d:%b} {d.day}" + ("" if d.year == today.year else f", {d.year}")


def _days(n: int) -> str:
    return f"{n} more day" + ("" if n == 1 else "s")


def suggest(inv: dict, vendor: dict, today: date, held_reason: str | None = None) -> dict:
    """One approved invoice -> {method, date, reason, saves_cents, pay_cents}. Pure: same input, same advice."""
    terms = discount_terms(vendor["early_pay_discount"])
    due = inv["due_date"] or today
    pay_on = max(due, today)
    late = (today - due).days if due < today else 0
    closed_note = ""

    if terms and inv["invoice_date"] and inv["subtotal_cents"]:
        rate, days = terms
        last_day = inv["invoice_date"] + timedelta(days=days)
        saves = apply_rate(inv["subtotal_cents"], rate)
        if today <= last_day:
            method = "CARD" if vendor["accepts_card_payment"] else vendor["preferred_payment_method"] or "EFT"
            return {"method": method, "date": last_day.isoformat(), "saves_cents": saves,
                    "pay_cents": (inv["total_cents"] or 0) - saves,
                    # The payment form doesn't deduct discounts (workflow/payments.py is outside this read-only
                    # feature), so the advice says so instead of promising what the Pay button won't do.
                    "reason": f"{vendor['legal_name']} gives {_pct(rate)} off the pre-tax amount if paid within {days} days of "
                              f"the invoice ({_day(inv['invoice_date'], today)}): {fmt((inv['total_cents'] or 0) - saves, inv['currency'])} "
                              f"instead of {fmt(inv['total_cents'], inv['currency'])}. The discount isn't deducted automatically "
                              f"yet: confirm it with the vendor when paying.",
                    "held": held_reason}
        closed_note = f" The {_pct(rate)} early-payment discount ({fmt(saves, inv['currency'])}) closed on {_day(last_day, today)}."

    when = (f"It's {late} days overdue: pay today." if late else
            f"Paying on the due date, not today, keeps the cash {_days((pay_on - today).days)}."
            if pay_on > today else "It's due today.")
    if vendor["accepts_card_payment"]:
        reason = (f"{vendor['legal_name']} takes cards. A single-use card is locked to them and to exactly "
                  f"{fmt(inv['total_cents'], inv['currency'])}, so there are no bank details anyone could swap. {when}")
        method = "CARD"
    else:
        method = vendor["preferred_payment_method"] if vendor["preferred_payment_method"] in ("EFT", "CHEQUE") else "EFT"
        reason = f"{vendor['legal_name']} doesn't take cards. {when}"
    return {"method": method, "date": pay_on.isoformat(), "saves_cents": 0, "pay_cents": inv["total_cents"],
            "reason": reason + closed_note, "held": held_reason}


def year_review(payments: list[dict], rewards_rate: Decimal) -> dict:
    """This year's money left on the table: discounts missed, and transfers/cheques that could have been cards."""
    taken, missed, could_card = [], [], []
    for p in payments:
        terms = discount_terms(p["early_pay_discount"])
        if terms and p["invoice_date"] and p["paid_date"]:
            rate, days = terms
            if p["discount_taken_cents"] > 0:
                taken.append(p)
            elif (p["paid_date"] - p["invoice_date"]).days > days:
                missed.append({**p, "missed_cents": apply_rate(p["subtotal_cents"], rate)})
        if p["accepts_card_payment"] and p["method"] in ("EFT", "CHEQUE"):
            could_card.append(p)

    by_vendor: dict[str, int] = {}
    for m in missed:
        by_vendor[m["vendor_name"]] = by_vendor.get(m["vendor_name"], 0) + m["missed_cents"]
    missed_cents = sum(m["missed_cents"] for m in missed)
    card_cents = sum(p["amount_cad_cents"] for p in could_card)
    return {
        "discounts_taken": {"count": len(taken), "cents": sum(p["discount_taken_cents"] for p in taken)},
        "discounts_missed": {"count": len(missed), "cents": missed_cents,
                             "breakdown": breakdowns.breakdown(breakdowns.top_parts(list(by_vendor.items()), 4, "{n} more vendors"),
                                                               missed_cents, "Missed", "2% of the pre-tax amount, paid after day 10.")},
        "could_have_been_card": {"count": len(could_card), "cents": card_cents,
                                 "vendors": sorted({p["vendor_name"] for p in could_card})},
        "rewards_rate": str(rewards_rate),
        "rewards_cents": apply_rate(card_cents, rewards_rate) if rewards_rate else None,
    }


def suggestions(conn) -> dict:
    today = config.TODAY
    invoices = conn.execute(
        """SELECT i.*, v.legal_name AS vendor_name FROM invoices i JOIN vendors v USING (vendor_id)
           WHERE i.status = 'approved' AND NOT i.is_credit_note
             AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.invoice_id AND p.status <> 'cancelled')
           ORDER BY i.due_date, i.invoice_id""").fetchall()
    vendors = {v["vendor_id"]: v for v in conn.execute("SELECT * FROM vendors")}
    # A payment to a vendor whose bank change isn't verified will be held (CLAUDE.md): say so up front.
    unverified = {r["vendor_id"] for r in conn.execute(
        "SELECT vendor_id FROM bank_change_history WHERE NOT verified_by_callback AND callback_outcome IS NULL")}
    out = []
    for inv in invoices:
        v = vendors[inv["vendor_id"]]
        held = (f"Payments to {v['legal_name']} are held until their bank change is confirmed by phone."
                if v["vendor_id"] in unverified else None)
        out.append({"invoice_id": inv["invoice_id"], "vendor_name": inv["vendor_name"], "vendor_invoice_number": inv["vendor_invoice_number"],
                    "total_cents": inv["total_cents"], "currency": inv["currency"], "due_date": inv["due_date"],
                    **suggest(inv, v, today, held)})

    paid = conn.execute(
        """SELECT p.method, p.paid_date, p.amount_cad_cents, p.discount_taken_cents, i.invoice_date, i.subtotal_cents,
                  v.legal_name AS vendor_name, v.early_pay_discount, v.accepts_card_payment
           FROM payments p JOIN invoices i USING (invoice_id) JOIN vendors v ON v.vendor_id = p.vendor_id
           WHERE p.status IN ('settled', 'outstanding') AND p.paid_date BETWEEN %s AND %s""",
        (date(today.year, 1, 1), today)).fetchall()
    out.sort(key=lambda s: (s["date"], s["invoice_id"]))     # the most urgent first: a discount deadline beats a due date
    return {"suggestions": out, "year": year_review(paid, config.CARD_REWARDS_RATE)}
