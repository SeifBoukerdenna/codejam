"""System health (app/health.py): SLO arithmetic, and that real failures show up as breaches."""

from app import health
from app.health import percentile, slo


def test_percentile_is_a_value_that_really_happened():
    times = [0.04, 0.05, 0.05, 0.06, 2.2]
    assert percentile(times, 50) == 0.05
    assert percentile(times, 95) == 2.2
    assert percentile([], 50) is None


def test_error_budget():
    ok = slo("read", "", good=54, total=56, objective=0.95, bad_example="x")
    assert ok["met"] and ok["budget_allowed"] == 2.8 and ok["budget_left"] == round(1 - 2 / 2.8, 3)
    spent = slo("read", "", good=53, total=56, objective=0.95, bad_example="x")
    assert not spent["met"] and spent["budget_left"] == 0.0
    assert slo("read", "", good=0, total=0, objective=0.95, bad_example="")["met"]   # nothing measured: nothing broken


def _objective(report, name):
    return next(o for o in report["objectives"] if o["name"] == name)


def test_the_worker_times_real_reading(pconn):
    # finished_at used to be now() = when the transaction began, which made every read take 0 s.
    report = health.slis(pconn)
    assert report["latency"]["text_layer"]["p50"] > 0
    assert report["latency"]["tesseract"]["p50"] > report["latency"]["text_layer"]["p50"]   # OCR is the slow path
    assert all(o["met"] for o in report["objectives"])


def test_a_stuck_queue_spends_the_wait_budget_at_once(pconn):
    doc = pconn.execute("SELECT document_id FROM documents LIMIT 1").fetchone()["document_id"]
    for _ in range(4):   # four documents nobody has picked up for 10 minutes: the worker is down
        pconn.execute("INSERT INTO extraction_jobs (document_id, created_at) VALUES (%s, clock_timestamp() - interval '10 minutes')", (doc,))
    report = health.slis(pconn)
    wait = _objective(report, "wait")
    assert wait["bad"] == 4 and not wait["met"] and wait["budget_left"] == 0.0
    assert report["queue"]["waiting"] == 4 and report["queue"]["oldest_wait_seconds"] >= 600


def test_a_dead_workers_job_is_marked_stale(pconn):
    doc = pconn.execute("SELECT document_id FROM documents LIMIT 1").fetchone()["document_id"]
    pconn.execute("""INSERT INTO extraction_jobs (document_id, status, worker_id, claimed_at, attempts)
                     VALUES (%s, 'running', 'old-host:42', clock_timestamp() - interval '6 minutes', 1)""", (doc,))
    running = health.slis(pconn)["queue"]["running"]
    assert [(r["worker_id"], r["stale"]) for r in running] == [("old-host:42", True)]


def test_a_changed_audit_event_breaches_the_audit_objective(pconn):
    pconn.execute("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete")
    pconn.execute("UPDATE audit_events SET reason = 'edited' WHERE event_id = (SELECT max(event_id) FROM audit_events)")
    pconn.execute("ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete")
    audit = _objective(health.slis(pconn), "audit")
    assert not audit["met"] and "was changed after it was written" in audit["bad_example"]


def test_only_controllers_and_the_auditor_see_it(api):
    assert api("GET", "/health/slis", "U004").status_code == 403            # AP clerk
    assert api("GET", "/health/slis", "U003").status_code == 403            # finance manager
    assert api("GET", "/health/slis", "U002").status_code == 200            # controller
    auditor = api("GET", "/users", "U002").json()
    auditor_id = next(u["user_id"] for u in auditor if u["role"] == "auditor")
    assert api("GET", "/health/slis", auditor_id).status_code == 200
