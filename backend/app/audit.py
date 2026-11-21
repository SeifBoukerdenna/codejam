"""The one function every state change goes through to leave a trace.

The table is append-only at the database level (a trigger rejects UPDATE/DELETE), so this module only ever
INSERTs, and every event is signed into a chain (audit_chain.py) so that even a bypassed trigger is detected.
Call it inside the same transaction as the change it describes: either both are saved or neither.
"""

from datetime import date, datetime
from decimal import Decimal

from app import audit_chain


def _plain(value):
    """Make before/after snapshots JSON-safe (dates and decimals as strings, so nothing becomes a float)."""
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items() if k not in ("content",)}  # never copy file bytes
    if isinstance(value, list):
        return [_plain(v) for v in value]
    if isinstance(value, (date, datetime, Decimal)):
        return str(value)
    return value


def log(conn, *, actor: str | None, action: str, entity_type: str, entity_id: str,
        before=None, after=None, reason: str | None = None, on_behalf_of: str | None = None) -> None:
    audit_chain.append(conn, {
        "actor_user_id": actor, "on_behalf_of_user_id": on_behalf_of, "action": action,
        "entity_type": entity_type, "entity_id": str(entity_id),
        "before": _plain(before) if before is not None else None,
        "after": _plain(after) if after is not None else None,
        "reason": reason,
    })


def changed(before: dict, after: dict) -> tuple[dict, dict]:
    """Only the fields that actually changed, so the audit log reads 'total: 3439.00 -> 3339.00'."""
    keys = [k for k in after if before.get(k) != after.get(k)]
    return {k: before.get(k) for k in keys}, {k: after[k] for k in keys}

