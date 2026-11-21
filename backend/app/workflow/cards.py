"""Single-use Brim virtual cards: one card per payment, issued at release, charged once by the vendor.

Why a card instead of a bank transfer: the card can only ever be charged by that vendor, for that exact
amount, once. If the card number leaks, or the vendor (or a fraudster posing as them) tries to charge more or
charge twice, it's declined. A bank account, once shared, can't be locked like that.

Every charge attempt is recorded with the decision and its reason in plain words. Cardholders' most common
complaint about card issuers is "my card was blocked and nobody would tell me why": here the reason is always
on the screen, next to the attempt.
"""

import secrets
from datetime import date, timedelta

from app import audit, config
from app.checks.duplicates import card_descriptor_matches
from app.money import fmt

# DECISION: a card stays valid 30 days after it's issued. Long enough for a vendor's monthly billing run,
# short enough that a forgotten card doesn't sit open for months.
VALID_DAYS = 30


def issue(conn, payment: dict, user: dict) -> dict:
    """Create the card for a released card payment and 'send' it to the vendor's AP contact."""
    vendor = conn.execute("SELECT * FROM vendors WHERE vendor_id = %s", (payment["vendor_id"],)).fetchone()
    n = conn.execute("SELECT count(*) + 1 AS n FROM virtual_cards").fetchone()["n"]
    card = {
        "card_id": f"VC-{n:05d}", "payment_id": payment["payment_id"], "vendor_id": payment["vendor_id"],
        "last4": f"{secrets.randbelow(10000):04d}", "expires_on": config.TODAY + timedelta(days=VALID_DAYS),
        "limit_cents": payment["amount_cents"], "currency": payment["currency"], "status": "active",
        "sent_to": vendor["ap_contact_email"], "issued_by": user["user_id"],
    }
    conn.execute(
        """INSERT INTO virtual_cards (card_id, payment_id, vendor_id, last4, expires_on, limit_cents, currency, status,
                                      sent_to, issued_by)
           VALUES (%(card_id)s, %(payment_id)s, %(vendor_id)s, %(last4)s, %(expires_on)s, %(limit_cents)s,
                   %(currency)s, %(status)s, %(sent_to)s, %(issued_by)s)""", card)
    audit.log(conn, actor=user["user_id"], action="card.issued", entity_type="payment", entity_id=payment["payment_id"],
              after={k: str(v) for k, v in card.items()},
              reason=f"Single-use card ••••{card['last4']} for exactly {fmt(card['limit_cents'], card['currency'])}, "
                     f"locked to {vendor['legal_name']}, sent to {vendor['ap_contact_email']}")
    return card


def decide(card: dict, vendor_name: str, merchant: str, amount_cents: int, today: date) -> tuple[bool, str]:
    """The card's rules, checked in order. Pure function: same card + same charge = same answer, every time."""
    limit = fmt(card["limit_cents"], card["currency"])
    if card["status"] == "cancelled":
        return False, "Declined: this card was cancelled when its payment was stopped."
    if card["status"] == "used":
        return False, "Declined: this is a single-use card and it has already been charged."
    if today > card["expires_on"]:
        return False, f"Declined: the card expired on {card['expires_on']:%B %-d, %Y}."
    if not card_descriptor_matches(vendor_name, merchant):
        return False, f"Declined: the card only works at {vendor_name}, and this charge came from {merchant}."
    if amount_cents > card["limit_cents"]:
        extra = fmt(amount_cents - card["limit_cents"], card["currency"])
        return False, (f"Declined: {fmt(amount_cents, card['currency'])} is {extra} more than the {limit} this card "
                       f"allows. A card fee or extra charge needs its own approval.")
    # DECISION: exact amount only. A smaller charge would close the single-use card with the invoice part-paid.
    if amount_cents < card["limit_cents"]:
        return False, (f"Declined: {fmt(amount_cents, card['currency'])} is less than the {limit} invoice. "
                       f"The card takes one charge, so it must be for the full amount.")
    return True, f"Approved: {vendor_name}, exactly {limit}, first use."


def record_charge(conn, card: dict, merchant: str, amount_cents: int, user: dict) -> dict:
    """A charge attempt arrives. Decide, record it, and if approved: close the card and settle the payment."""
    from app.workflow.payments import settle   # payments imports this module, so import here to avoid a cycle

    vendor = conn.execute("SELECT legal_name FROM vendors WHERE vendor_id = %s", (card["vendor_id"],)).fetchone()
    approved, reason = decide(card, vendor["legal_name"], merchant, amount_cents, config.TODAY)
    # Logged before settling, so the story reads "charge approved" then "payment confirmed".
    audit.log(conn, actor=user["user_id"], action="card.charge_approved" if approved else "card.charge_declined",
              entity_type="payment", entity_id=card["payment_id"],
              after={"card_id": card["card_id"], "merchant": merchant, "amount_cents": amount_cents}, reason=reason)
    txn_id = None
    if approved:
        payment = conn.execute("SELECT * FROM payments WHERE payment_id = %s", (card["payment_id"],)).fetchone()
        txn_id = settle(conn, payment, user, merchant=merchant)
        conn.execute("UPDATE virtual_cards SET status = 'used', closed_at = now() WHERE card_id = %s", (card["card_id"],))
    return conn.execute(
        """INSERT INTO card_authorizations (card_id, merchant, amount_cents, approved, reason, txn_id, recorded_by)
           VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING *""",
        (card["card_id"], merchant, amount_cents, approved, reason, txn_id, user["user_id"])).fetchone()


def cancel_for_payment(conn, payment_id: str) -> None:
    conn.execute("UPDATE virtual_cards SET status = 'cancelled', closed_at = now() WHERE payment_id = %s AND status = 'active'",
                 (payment_id,))
