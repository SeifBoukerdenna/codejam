"""Bank statement check: every debit on the bank statement is matched to a payment we made, or explained.

The most common complaints about card issuers and banks are fees nobody can explain, money taken without a
clear reason, and payments that "weren't received". This answers all three from our side: each line of the
statement either matches a payment we released (and is linked to its invoice and approvals), or it's named
in plain words with what to do about it. The questions for the bank are written up with dates, amounts and
trace numbers, so one email settles them instead of a phone queue.

Matching, line by line (deterministic, same answer every run):
  EFT PMT ... 192411     the 6-digit trace = last 6 digits of our payment reference (BRIM-EFT-18192411)
  CHEQUE 5001 CLEARED    a cheque we issued for the same amount, oldest first (cheque numbers aren't in our data)
  MONTHLY ACCOUNT FEE    a normal bank fee, just not booked yet
  WIRE FEE               we never send wires (EFT, cheque, card only), so the bank has to explain it
  PREAUTH DEBIT ...      money pulled by a pre-authorized debit that no invoice or payment explains
"""

import re
from datetime import date, timedelta

from app.money import fmt

TRACE_RE = re.compile(r"^EFT PMT .* (\d{6})$")
CHEQUE_RE = re.compile(r"^CHEQUE (\d+) CLEARED$")
# DECISION: a payment we settled in the last 3 days may not be on the statement yet ("in transit"); older
# ones must be, or the bank never took the money.
IN_TRANSIT_DAYS = 3

# kind -> (title, tone, what to do)
KINDS = {
    "matched": ("Matches a payment", "positive", None),
    "cheque_cashed": ("Cheque cashed", "warning", "mark_cashed"),
    "amount_differs": ("Different amount than we sent", "negative", "ask_bank"),
    "bank_fee": ("Bank fee not booked", "warning", "book_fee"),
    "fee_without_cause": ("Fee for something we didn't do", "negative", "ask_bank"),
    "unknown_debit": ("Debit nobody set up", "negative", "ask_bank"),
    "unmatched": ("No payment matches", "negative", "ask_bank"),
}


def _payments(conn) -> list[dict]:
    return conn.execute(
        """SELECT p.*, v.legal_name AS vendor_name, i.vendor_invoice_number FROM payments p
           JOIN vendors v USING (vendor_id) JOIN invoices i USING (invoice_id)
           WHERE p.status IN ('released', 'scheduled', 'outstanding', 'settled')""").fetchall()


def check_statement(conn) -> dict:
    lines = conn.execute("SELECT * FROM bank_statement WHERE debit_cents IS NOT NULL ORDER BY posted_date, bank_txn_id").fetchall()
    reviews = {r["bank_txn_id"]: r for r in conn.execute(
        """SELECT r.*, u.full_name AS resolved_by_name FROM statement_reviews r
           LEFT JOIN users u ON u.user_id = r.resolved_by""")}
    payments = _payments(conn)
    by_trace = {p["reference"][-6:]: p for p in payments if p["method"] == "EFT" and p["reference"]}
    cheques = sorted((p for p in payments if p["method"] == "CHEQUE" and p["paid_date"]), key=lambda p: (p["paid_date"], p["payment_id"]))
    used = set()

    out = []
    for line in lines:
        desc, cents = line["description"], line["debit_cents"]
        pay, note, at_stake = None, "", cents
        trace, cheque = TRACE_RE.match(desc), CHEQUE_RE.match(desc)
        if trace and trace.group(1) in by_trace:
            pay = by_trace[trace.group(1)]
            if cents == pay["amount_cad_cents"]:
                kind = "matched"
            else:
                kind, at_stake = "amount_differs", cents - pay["amount_cad_cents"]
                note = (f"The bank took {fmt(cents)} for {pay['payment_id']} to {pay['vendor_name']}, but we sent "
                        f"{fmt(pay['amount_cad_cents'])}: {fmt(cents - pay['amount_cad_cents'])} more.")
        elif cheque:
            issued = [p for p in cheques if p["payment_id"] not in used and p["paid_date"] <= line["posted_date"]]
            pay = next((p for p in issued if p["amount_cad_cents"] == cents), None)
            # DECISION: no exact match, but an uncashed cheque within $1 = the same cheque, cleared for a different
            # amount. That's how an altered cheque shows up, so it's flagged, not quietly matched.
            near = min((p for p in issued if p["status"] == "outstanding" and abs(p["amount_cad_cents"] - cents) <= 100),
                       key=lambda p: abs(p["amount_cad_cents"] - cents), default=None)
            if pay is None and near:
                pay, kind, at_stake = near, "amount_differs", cents - near["amount_cad_cents"]
                note = (f"Cheque {cheque.group(1)} cleared for {fmt(cents)}, but the cheque we wrote ({near['payment_id']}, "
                        f"{near['vendor_name']}) was for {fmt(near['amount_cad_cents'])}. A cheque that clears for a "
                        f"different amount may have been altered.")
            elif pay is None:
                kind, note = "unmatched", f"Cheque {cheque.group(1)} for {fmt(cents)} cleared, but we issued no cheque for that amount."
            elif pay["status"] == "outstanding":
                kind = "cheque_cashed"
                note = (f"{pay['vendor_name']} cashed the cheque for {pay['payment_id']} on {line['posted_date']:%B %-d}. "
                        f"Our books still say it isn't cashed.")
            else:
                kind = "matched"
        elif desc == "MONTHLY ACCOUNT FEE":
            kind, note = "bank_fee", "The bank's monthly fee. It's on no invoice, so it isn't in our books yet."
        elif "FEE" in desc:
            kind, note = "fee_without_cause", (f"A {desc.lower()} of {fmt(cents)}, but we sent no wire: we pay by bank "
                                               f"transfer, cheque and card only.")
        elif desc.startswith("PREAUTH DEBIT"):
            kind, note = "unknown_debit", (f"{fmt(cents)} pulled by pre-authorized debit {desc.split()[-1]}. No invoice, "
                                           f"payment or agreement of ours explains it.")
        else:
            kind, note = "unmatched", f"{fmt(cents)} left the account and no payment of ours matches it."
        if pay:
            used.add(pay["payment_id"])
            if kind == "matched":
                note = f"{pay['payment_id']} to {pay['vendor_name']}, invoice #{pay['vendor_invoice_number']}."

        title, tone, todo = KINDS[kind]
        review = reviews.get(line["bank_txn_id"])
        out.append({
            "bank_txn_id": line["bank_txn_id"], "posted_date": line["posted_date"].isoformat(), "description": desc,
            "amount_cents": cents, "at_stake_cents": at_stake, "kind": kind, "title": title, "tone": tone, "explanation": note,
            "todo": None if review else todo,
            "resolution": review["resolution"] if review else None,
            "resolved_by_name": review["resolved_by_name"] if review else None,
            "resolved_at": review["resolved_at"].isoformat() if review else None,
            "payment_id": pay["payment_id"] if pay else None, "invoice_id": pay["invoice_id"] if pay else None,
            "vendor_name": pay["vendor_name"] if pay else None,
        })

    # The other direction: payments we marked as paid that never reached the statement.
    last = lines[-1]["posted_date"] if lines else None
    missing = [p for p in payments if last and p["status"] == "settled" and p["method"] in ("EFT", "CHEQUE")
               and p["payment_id"] not in used and p["paid_date"] and p["paid_date"] <= last - timedelta(days=IN_TRANSIT_DAYS)]

    open_lines = [l for l in out if l["todo"]]
    return {
        "lines": out,
        "statement_from": lines[0]["posted_date"].isoformat() if lines else None,
        "statement_to": last.isoformat() if last else None,
        "matched": sum(l["kind"] == "matched" for l in out),
        "to_explain": len(open_lines),
        "unexplained_cents": sum(l["at_stake_cents"] for l in open_lines if l["todo"] == "ask_bank"),
        # Asking isn't the same as getting it back: these stay "in question" until the bank answers.
        "waiting_cents": sum(l["at_stake_cents"] for l in out if l["resolution"] == "asked_bank"),
        "missing_from_statement": [{"payment_id": p["payment_id"], "invoice_id": p["invoice_id"], "vendor_name": p["vendor_name"],
                                    "amount_cents": p["amount_cad_cents"], "paid_date": p["paid_date"].isoformat()}
                                   for p in missing],
    }


def letter_to_bank(result: dict, signer: str) -> str:
    """One email with every debit we need the bank to explain, grouped, with dates, amounts and traces."""
    groups = [
        ("Pre-authorized debits we never set up", "unknown_debit"),
        ("Fees for wires we never sent", "fee_without_cause"),
        ("Payments that left the account for a different amount than we sent", "amount_differs"),
        ("Debits we can't match to any payment", "unmatched"),
    ]
    asks = [l for l in result["lines"] if l["todo"] == "ask_bank"]
    parts = []
    for heading, kind in groups:
        rows = [l for l in asks if l["kind"] == kind]
        if rows:
            parts.append(heading + ":\n" + "\n".join(
                f"- {_day(l['posted_date'])}, {l['description']}, {fmt(l['amount_cents'])}"
                + (f" (we sent {fmt(l['amount_cents'] - l['at_stake_cents'])})" if kind == "amount_differs" else "")
                for l in rows))
    total = sum(l["at_stake_cents"] for l in asks)
    return (f"Hello,\n\nWe checked our business account statement from {_day(result['statement_from'])} to "
            f"{_day(result['statement_to'])} against our payment records. The debits below don't match anything we "
            f"authorized. Could you tell us what each one is, and refund the ones that were taken in error?\n\n"
            + "\n\n".join(parts) +
            f"\n\nTotal in question: {fmt(total)}.\n\nBest regards,\n{signer}\nAccounts Payable · Harborline Logistics\n"
            f"ap@harborline-logistics.example")


def _day(iso: str) -> str:
    return date.fromisoformat(iso).strftime("%B %-d, %Y")
