"""Who is asking, and what they may do. ALL permission decisions are made by can() in this file.

DECISION: no real login for the demo. The UI's user switcher sends the chosen user_id in an X-User-Id
header; the server trusts it as identity but decides every permission itself.

can() returns a Decision with a reason in plain words. The API uses it to refuse (403 + reason) and to tell
the UI which buttons to show and why one is disabled, so the rules live in exactly one place.
"""

from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException

from app.db import get_conn

PREPARERS = {"ap_clerk", "finance_manager", "controller_admin"}   # AP work: intake, review, prepare payments
FINANCE = {"finance_manager", "controller_admin"}                 # release payments, approve vendors

ROLE_WORDS = {"ap_clerk": "AP clerks", "approver": "Department managers", "employee": "Employees",
              "finance_manager": "Finance managers", "controller_admin": "Controllers", "auditor": "Auditors"}


@dataclass
class Decision:
    allowed: bool
    reason: str = ""

    def as_dict(self) -> dict:
        return {"allowed": self.allowed, "reason": self.reason}


def allow() -> Decision:
    return Decision(True)


def deny(reason: str) -> Decision:
    return Decision(False, reason)


def current_user(x_user_id: str | None = Header(default=None), conn=Depends(get_conn)) -> dict | None:
    if not x_user_id:
        return None
    return conn.execute("SELECT * FROM users WHERE user_id = %s", (x_user_id,)).fetchone()


def _release_threshold(conn) -> int:
    row = conn.execute("SELECT threshold_cents FROM approval_policies WHERE rule_id = 'P09'").fetchone()
    return row["threshold_cents"]


def can(conn, user: dict | None, action: str, resource: dict | None = None) -> Decision:
    if user is None:
        return deny("Choose who you are first (top right).")
    if user["status"] != "active":
        return deny(f"{user['full_name']} is {user['status'].replace('_', ' ')} and can't act in the system.")
    if user["role"] == "auditor":
        return deny("Auditors have read-only access.")
    role = user["role"]

    if action in {"inbox.process", "document.upload", "invoice.edit", "invoice.submit", "invoice.acknowledge",
                  "invoice.reject", "invoice.recheck", "payment.prepare", "vendor.create", "vendor.request_bank_change",
                  "email.answer", "recovery.update", "bank.reconcile"}:
        if role not in PREPARERS:
            return deny(f"{ROLE_WORDS[role]} can't do this; it's AP work.")
        if action == "invoice.reject" and resource and resource["status"] in ("approved", "scheduled", "paid"):
            return deny("This invoice is already approved; cancel its payment instead.")
        return allow()

    if action in {"invoice.approve", "invoice.decline"}:
        # resource = the approval step waiting to be acted on
        if resource is None:
            return deny("This invoice isn't waiting for an approval.")
        if resource["approver_user_id"] != user["user_id"]:
            return deny(f"Waiting for {resource['approver_name']}, not you.")
        return allow()

    if action == "payment.release":
        # resource = payment row plus 'invoice_approver_ids'
        if role not in FINANCE:
            return deny("Only a finance manager or controller can release a payment. AP clerks prepare them (P09).")
        if resource["status"] != "prepared":
            return deny("Only a prepared payment can be released.")
        threshold = _release_threshold(conn)
        if resource["amount_cad_cents"] > threshold and role != "controller_admin":
            return deny("Payments over $100,000 must be released by the controller (P10).")
        if user["user_id"] in resource["invoice_approver_ids"]:
            return deny("You approved this invoice, so you can't release its payment (separation of duties, P11).")
        # DECISION: the person who prepared a payment can't release it either (four-eyes on money out).
        if user["user_id"] == resource["prepared_by"]:
            return deny("You prepared this payment, so someone else has to release it.")
        return allow()

    if action in {"payment.cancel", "vendor.approve", "vendor.hold"}:
        if role not in FINANCE:
            return deny("Only a finance manager or controller can do this.")
        # DECISION: whoever onboarded a vendor can't approve it.
        if action == "vendor.approve" and resource and resource.get("created_by") == user["user_id"]:
            return deny("You onboarded this vendor, so someone else has to approve it.")
        return allow()

    if action == "payment.settle":
        if role not in PREPARERS:
            return deny("Only AP or finance can record a bank settlement.")
        return allow()

    if action == "card.record_charge":
        # Stands in for the card network telling us the vendor charged the card (there is no real network).
        if role not in PREPARERS:
            return deny("Only AP or finance can record a card charge.")
        return allow()

    if action == "vendor.verify_bank_change":
        if role not in PREPARERS:
            return deny("Only AP or finance can verify bank details.")
        if resource and resource.get("changed_by_user_id") == user["user_id"]:
            return deny("You entered this bank change, so someone else has to call the vendor to verify it.")
        return allow()

    return deny(f"Unknown action {action}.")


def require(conn, user: dict | None, action: str, resource: dict | None = None) -> dict:
    """Raise 403 with the reason if the action isn't allowed; return the user otherwise."""
    decision = can(conn, user, action, resource)
    if not decision.allowed:
        raise HTTPException(403, decision.reason)
    return user
