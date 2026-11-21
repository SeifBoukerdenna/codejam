"""The signed audit chain (audit_chain.py): it verifies after real work, it names the exact event someone
changed behind the trigger's back, and concurrent writers can't fork it."""

import threading

from app import audit, audit_chain, db


def test_chain_verifies_after_seed(conn):
    result = audit_chain.verify(conn)
    assert result["ok"], result["reason"]
    assert result["checked"] >= 1


def test_chain_verifies_after_the_full_trap_pipeline(pconn):
    # Inbox sorted, every document read by the worker, every check run: hundreds of events from many writers.
    result = audit_chain.verify(pconn)
    assert result["ok"], result["reason"]
    assert result["checked"] > 100


def test_tampering_is_detected_at_the_right_event(pconn):
    target = pconn.execute("SELECT event_id, action, entity_id FROM audit_events "
                           "WHERE action = 'invoice.create' ORDER BY event_id LIMIT 1 OFFSET 5").fetchone()
    # What a superuser could do: switch the append-only trigger off, edit, switch it back on.
    # (pconn rolls back after the test, the ALTER TABLE included.)
    pconn.execute("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete")
    pconn.execute("UPDATE audit_events SET reason = 'nothing to see here' WHERE event_id = %s", (target["event_id"],))
    pconn.execute("ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete")

    result = audit_chain.verify(pconn)
    assert not result["ok"]
    assert result["first_bad_event_id"] == target["event_id"]
    assert result["reason"] == (f"Event #{target['event_id']} ({target['action']} on {target['entity_id']}) "
                                f"was changed after it was written.")


def test_deleting_an_event_breaks_the_chain_at_the_next_one(pconn):
    ids = [r["event_id"] for r in pconn.execute("SELECT event_id FROM audit_events ORDER BY event_id LIMIT 12")]
    pconn.execute("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete")
    pconn.execute("DELETE FROM audit_events WHERE event_id = %s", (ids[10],))
    pconn.execute("ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete")
    result = audit_chain.verify(pconn)
    assert not result["ok"] and result["first_bad_event_id"] == ids[11]


def test_concurrent_writers_keep_a_single_valid_chain(db_url):
    """Two connections writing at the same time. Without the advisory lock both would read the same last hash
    and the chain would fork; with it, every event links to exactly the one before."""
    start = threading.Barrier(2)
    errors = []

    def writer(name):
        try:
            with db.connect(db_url) as c:
                start.wait()
                for i in range(25):
                    with c.transaction():
                        audit.log(c, actor=None, action="test.concurrent", entity_type="test",
                                  entity_id=f"{name}-{i}", after={"i": i}, reason="concurrency test")
        except Exception as exc:  # noqa: BLE001 - surfaced by the assert below
            errors.append(exc)

    threads = [threading.Thread(target=writer, args=(n,)) for n in ("a", "b")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors, errors
    with db.connect(db_url) as c:
        result = audit_chain.verify(c)
        written = c.execute("SELECT count(*) AS n FROM audit_events WHERE action = 'test.concurrent'").fetchone()["n"]
    assert result["ok"], result["reason"]
    assert written >= 50


def test_only_the_auditor_and_controllers_can_run_the_check(api):
    assert api("GET", "/audit/verify", "U006").json()["ok"] is True          # auditor
    assert api("GET", "/audit/verify", "U002").json()["ok"] is True          # controller
    r = api("GET", "/audit/verify", "U004")                                  # AP clerk
    assert r.status_code == 403 and "auditor or a controller" in r.json()["detail"]
