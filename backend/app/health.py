"""System health: service level indicators (what we measure) and objectives (what we promise), for the extraction
worker and the audit log. Read-only: everything comes from extraction_jobs, extractions, invoices and audit_events.

An SLO is "at least <objective> of events are good over <window>". The error budget is the bad events the objective
allows: 95% over 56 documents allows 2.8 slow ones. Spending the budget is fine; running out means stop shipping
changes and fix reliability first. That's the whole idea, kept small enough to explain.
"""

import math
from datetime import timedelta

from app import audit_chain
from app.worker import STALE_AFTER_SECONDS

WINDOW = timedelta(days=28)            # a rolling 4 weeks, the usual SLO window: long enough to average out a bad day

# SLO 1: documents are read quickly once a worker takes them (claimed -> finished: the worker's own speed).
READ_OBJECTIVE = 0.95
READ_THRESHOLD_SECONDS = 10            # a text PDF takes well under a second; a scan 1-5 s with 3 OCR passes

# SLO 2: nobody waits for a worker (arrived -> claimed). A document still waiting counts with its wait so far, so a
# stuck queue breaches this immediately, not after the documents are finally read.
# DECISION: the same 95% as SLO 1. At ~50 invoices a month a 99% objective allows 0.5 bad documents: a budget of zero
# isn't a budget, every single slow file would be a breach. Separate from SLO 1 on purpose: "the worker is slow" and
# "we need more workers" are different problems with different fixes.
WAIT_OBJECTIVE = 0.95
WAIT_THRESHOLD_SECONDS = 60

# SLO 3: the signed audit chain verifies (audit_chain.py). Not a ratio: one tampered event is a breach. No budget.

CONFIDENCE_BANDS = [(0.99, "Exact (PDF text)"), (0.90, "OCR passes agreed"), (0.60, "OCR passes disagreed"),
                    (0.0, "Malformed or missing")]


def percentile(values: list[float], p: float) -> float | None:
    """Nearest-rank percentile: the smallest value with at least p% of values at or below it. No interpolation,
    so the answer is always a duration that really happened."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(p / 100 * len(ordered)) - 1)]


def slo(name: str, sentence: str, good: int, total: int, objective: float, bad_example: str) -> dict:
    """Met or breached, and how much of the error budget is left."""
    bad = total - good
    allowed = total * (1 - objective)                  # bad events the objective tolerates
    left = 1.0 if bad == 0 else max(0.0, 1 - bad / allowed) if allowed > 0 else 0.0
    return {
        "name": name, "sentence": sentence, "objective": objective, "good": good, "total": total, "bad": bad,
        "actual": good / total if total else None, "met": total == 0 or good / total >= objective,
        "budget_allowed": round(allowed, 1), "budget_left": round(left, 3), "bad_example": bad_example if bad else None,
    }


def confidence_bands(scores: list[float]) -> list[dict]:
    counts = []
    for i, (floor, label) in enumerate(CONFIDENCE_BANDS):
        ceiling = CONFIDENCE_BANDS[i - 1][0] if i else math.inf
        counts.append({"label": label, "from": floor, "count": sum(floor <= s < ceiling for s in scores)})
    return counts


def slis(conn) -> dict:
    now = conn.execute("SELECT clock_timestamp() AS t").fetchone()["t"]
    since = now - WINDOW
    jobs = conn.execute(
        """SELECT j.*, x.engine, extract(epoch FROM j.finished_at - j.claimed_at)::float AS read_seconds,
                  extract(epoch FROM coalesce(j.claimed_at, %s) - j.created_at)::float AS wait_seconds
           FROM extraction_jobs j
           LEFT JOIN LATERAL (SELECT engine FROM extractions e WHERE e.document_id = j.document_id
                              ORDER BY extraction_id DESC LIMIT 1) x ON true
           WHERE j.created_at >= %s ORDER BY j.job_id""", (now, since)).fetchall()

    read = [j for j in jobs if j["status"] == "done" and j["read_seconds"] is not None]
    fast = [j for j in read if j["read_seconds"] < READ_THRESHOLD_SECONDS]
    slowest = max(read, key=lambda j: j["read_seconds"], default=None)
    waited = [j for j in jobs if j["wait_seconds"] is not None]
    prompt = [j for j in waited if j["wait_seconds"] < WAIT_THRESHOLD_SECONDS]
    longest = max(waited, key=lambda j: j["wait_seconds"], default=None)
    chain = audit_chain.verify(conn)

    objectives = [
        slo("read", f"{READ_OBJECTIVE:.0%} of documents are read in under {READ_THRESHOLD_SECONDS} s", len(fast), len(read),
            READ_OBJECTIVE, f"Slowest: document {slowest['document_id']}, {slowest['read_seconds']:.1f} s" if slowest else ""),
        slo("wait", f"{WAIT_OBJECTIVE:.0%} of documents start being read within {WAIT_THRESHOLD_SECONDS} s of arriving",
            len(prompt), len(waited), WAIT_OBJECTIVE,
            f"Longest wait: document {longest['document_id']}, {longest['wait_seconds']:.0f} s" if longest else ""),
        # Not a ratio: one changed event is a breach, so there's no budget to spend (and "good" isn't counted).
        {"name": "audit", "sentence": "The signed audit log verifies, every event", "objective": 1.0,
         "good": None, "total": chain["checked"], "bad": 0 if chain["ok"] else 1, "actual": None, "met": chain["ok"],
         "budget_allowed": 0, "budget_left": None, "bad_example": None if chain["ok"] else chain["reason"]},
    ]

    queued = [j for j in jobs if j["status"] == "queued"]
    running = [j for j in jobs if j["status"] == "running"]
    by_engine = {}
    for engine in ("text_layer", "tesseract"):
        times = [j["read_seconds"] for j in read if j["engine"] == engine]
        by_engine[engine] = {"count": len(times), "p50": percentile(times, 50), "p95": percentile(times, 95),
                             "max": max(times, default=None)}

    # Touchless: read and sent to approval with no person involved (pipeline.py submits as the system, actor NULL).
    invoices = conn.execute(
        """SELECT count(*) AS read,
                  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM audit_events e WHERE e.entity_type = 'invoice'
                        AND e.entity_id = i.invoice_id AND e.action = 'invoice.submit' AND e.actor_user_id IS NULL))
                    AS touchless
           FROM invoices i WHERE i.source <> 'history' AND i.status <> 'extracting'""").fetchone()

    scores = [float(f["score"]) for row in conn.execute(
        """SELECT DISTINCT ON (document_id) field_confidence FROM extractions ORDER BY document_id, extraction_id DESC""")
        for f in row["field_confidence"].values() if f.get("score") is not None]

    failures = conn.execute(
        """SELECT j.job_id, j.document_id, d.filename, j.error, j.attempts, j.finished_at
           FROM extraction_jobs j JOIN documents d USING (document_id)
           WHERE j.status = 'failed' AND j.finished_at >= %s ORDER BY j.finished_at DESC""",
        (now - timedelta(hours=24),)).fetchall()
    workers = conn.execute(
        """SELECT worker_id, count(*) AS jobs, max(coalesce(finished_at, claimed_at)) AS last_seen
           FROM extraction_jobs WHERE worker_id IS NOT NULL AND claimed_at >= %s
           GROUP BY worker_id ORDER BY last_seen DESC""", (since,)).fetchall()

    return {
        "measured_at": now.isoformat(), "window_days": WINDOW.days, "objectives": objectives,
        "queue": {"waiting": len(queued),
                  "oldest_wait_seconds": max((j["wait_seconds"] for j in queued), default=None),
                  "running": [{"job_id": j["job_id"], "document_id": j["document_id"], "worker_id": j["worker_id"],
                               "running_seconds": (now - j["claimed_at"]).total_seconds(), "attempts": j["attempts"],
                               "stale": (now - j["claimed_at"]).total_seconds() > STALE_AFTER_SECONDS} for j in running],
                  "stale_after_seconds": STALE_AFTER_SECONDS},
        "latency": by_engine,
        "touchless": {"read": invoices["read"], "touchless": invoices["touchless"],
                      "rate": invoices["touchless"] / invoices["read"] if invoices["read"] else None},
        "confidence": {"fields": len(scores), "bands": confidence_bands(scores)},
        "failures_24h": failures,
        "workers": workers,
        "audit": {"ok": chain["ok"], "checked": chain["checked"], "reason": chain["reason"], "head": chain.get("head")},
    }
