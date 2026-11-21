"""`make tamper`: what a database administrator could do to the audit log, and how we'd still know.

As the database superuser it switches off the trigger that makes audit_events append-only, rewrites the reason of
one approval (the most recent one; any recent event if nobody has approved anything yet), switches the trigger
back on, then runs the same verification as the "Verify integrity" button. `make reseed` puts everything back.
"""

from app import audit_chain, db

TRIGGER = "audit_events_no_update_delete"


def main() -> None:
    with db.transaction() as conn:
        target = (conn.execute("SELECT * FROM audit_events WHERE action = 'invoice.approve' ORDER BY event_id DESC LIMIT 1").fetchone()
                  or conn.execute("SELECT * FROM audit_events WHERE reason IS NOT NULL ORDER BY event_id DESC LIMIT 1").fetchone())
        forged = "Approved after a phone call with the vendor"
        conn.execute(f"ALTER TABLE audit_events DISABLE TRIGGER {TRIGGER}")
        conn.execute("UPDATE audit_events SET reason = %s WHERE event_id = %s", (forged, target["event_id"]))
        conn.execute(f"ALTER TABLE audit_events ENABLE TRIGGER {TRIGGER}")
    print(f"Tampered with event #{target['event_id']} ({target['action']} on {target['entity_id']}), "
          f"trigger switched off and back on:")
    print(f"  reason before: {target['reason']!r}")
    print(f"  reason now:    {forged!r}")
    with db.connect() as conn:
        result = audit_chain.verify(conn)
    print(f"\nVerify integrity → {'OK' if result['ok'] else 'TAMPERING DETECTED'}: {result['reason']}")
    print("Run `make reseed` to restore the database.")


if __name__ == "__main__":
    main()
