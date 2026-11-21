"""Tamper-evident audit chain: every audit event is signed together with the signature of the event before it.

The trigger on audit_events stops UPDATE / DELETE / TRUNCATE, but a database superuser can switch the trigger
off. The chain makes that detectable: change one event, and its signature no longer matches; delete one, and the
next event no longer points at the right predecessor. verify() walks the chain and names the first bad event.

    hash = HMAC-SHA256(AUDIT_KEY, prev_hash || canonical_json(event))

DECISION: HMAC with a secret key, not a plain SHA-256. With a plain hash, someone who can edit the table can also
recompute every hash after their edit and the chain would still "verify". Without the key, they can't forge a
signature. Rejected: plain hash chain (only proves accidents, not tampering). In production the key lives in a KMS
and the latest hash is regularly copied outside the database (an "anchor"), so even deleting the newest events
or the whole table is noticed.
"""

import hashlib
import hmac
import json
from datetime import datetime, timezone

from psycopg.types.json import Jsonb

from app import config

GENESIS = b"\x00" * 32          # prev_hash of the very first event
# Any fixed number: the id of the one advisory lock every audit writer takes (see append()).
CHAIN_LOCK_ID = 41202026
# What the API returns for an event (alias e): the signature as hex text, since raw bytes aren't JSON.
EVENT_SELECT = """e.event_id, e.actor_user_id, e.on_behalf_of_user_id, e.action, e.entity_type, e.entity_id,
                  e.before, e.after, e.reason, e.created_at, encode(e.hash, 'hex') AS hash"""
SIGNED_COLUMNS = ("event_id", "actor_user_id", "on_behalf_of_user_id", "action", "entity_type", "entity_id",
                  "before", "after", "reason", "created_at", "prev_hash")


def canonical(event: dict) -> bytes:
    """One exact byte string per event, whoever computes it: sorted keys, no whitespace, UTC timestamps with
    microseconds (what Postgres stores), hashes as hex. Re-computable from the row as read back."""
    values = {}
    for column in SIGNED_COLUMNS:
        value = event[column]
        if column == "created_at":
            value = value.astimezone(timezone.utc).isoformat(timespec="microseconds")
        elif column == "prev_hash":
            value = bytes(value).hex()
        values[column] = value
    return json.dumps(values, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sign(prev_hash: bytes, event: dict) -> bytes:
    return hmac.new(config.AUDIT_KEY, bytes(prev_hash) + canonical(event), hashlib.sha256).digest()


def json_native(value):
    """Store before/after as the exact JSON types they'll come back as (dict, list, str, int, float, bool, None),
    so the signature computed now is the one recomputed when verifying."""
    return None if value is None else json.loads(json.dumps(value))


def append(conn, event: dict) -> dict:
    """Insert one audit event at the end of the chain. `event` has every SIGNED_COLUMNS field except event_id,
    created_at and prev_hash, which are set here."""
    # DECISION: a transaction-scoped advisory lock, taken before reading the last hash. Two transactions writing
    # at the same moment would otherwise both read the same last hash and fork the chain. The lock is held until
    # the transaction commits or rolls back, so writers queue up for a few milliseconds; ids are taken under
    # the lock, so event_id order IS chain order. Rejected: a separate "notary" process signing events after
    # commit (no waiting in the request path, but events sit unsigned for a moment; a good next step at scale).
    conn.execute("SELECT pg_advisory_xact_lock(%s)", (CHAIN_LOCK_ID,))
    last = conn.execute("SELECT hash FROM audit_events ORDER BY event_id DESC LIMIT 1").fetchone()
    prev_hash = bytes(last["hash"]) if last else GENESIS
    event_id = conn.execute("SELECT nextval(pg_get_serial_sequence('audit_events', 'event_id')) AS id").fetchone()["id"]
    row = {**event, "event_id": event_id, "created_at": datetime.now(timezone.utc), "prev_hash": prev_hash,
           "before": json_native(event.get("before")), "after": json_native(event.get("after"))}
    row["hash"] = sign(prev_hash, row)
    conn.execute(
        """INSERT INTO audit_events (event_id, actor_user_id, on_behalf_of_user_id, action, entity_type, entity_id,
                                     before, after, reason, created_at, prev_hash, hash)
           VALUES (%(event_id)s, %(actor_user_id)s, %(on_behalf_of_user_id)s, %(action)s, %(entity_type)s,
                   %(entity_id)s, %(before_json)s, %(after_json)s, %(reason)s, %(created_at)s, %(prev_hash)s, %(hash)s)""",
        {**row, "before_json": None if row["before"] is None else Jsonb(row["before"]),
         "after_json": None if row["after"] is None else Jsonb(row["after"])})
    return row


def verify(conn) -> dict:
    """Walk the whole chain in event_id order. Returns ok, how many events were checked, and the first bad one."""
    prev_hash = GENESIS
    checked = 0
    for row in conn.execute(f"SELECT {', '.join(SIGNED_COLUMNS)}, hash FROM audit_events ORDER BY event_id"):
        checked += 1
        where = f"Event #{row['event_id']} ({row['action']} on {row['entity_id']})"
        if bytes(row["prev_hash"]) != prev_hash:
            return {"ok": False, "checked": checked, "first_bad_event_id": row["event_id"],
                    "reason": f"The chain breaks at event #{row['event_id']}: the event before it was deleted or "
                              f"replaced after it was written."}
        if not hmac.compare_digest(sign(prev_hash, row), bytes(row["hash"])):
            return {"ok": False, "checked": checked, "first_bad_event_id": row["event_id"],
                    "reason": f"{where} was changed after it was written."}
        prev_hash = bytes(row["hash"])
    return {"ok": True, "checked": checked, "first_bad_event_id": None, "head": prev_hash.hex()[:16],
            "reason": f"All {checked:,} events verified: none was changed, removed or reordered."}
