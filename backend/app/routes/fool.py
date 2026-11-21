"""'Try to fool us': the tricks, launching one, and every attempt so far with what caught it.

Every upload counts as an attempt, so a judge's own doctored PDF shows up here next to the ready-made tricks.
"Caught" means the invoice did not sail through: something blocked it, a person must look at it, or it was
rejected. Nothing on this page decides that differently from the rest of the app; it only reads the results.
"""

from fastapi import APIRouter, Depends, HTTPException

from app.auth import can, current_user
from app.db import get_conn
from app.demo import fool

router = APIRouter(prefix="/api")

SEVERITY_ORDER = "CASE severity WHEN 'block' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END"


RESULT_ORDER = ["got_through", "reading", "unreadable", "caught"]


def _worst(a: str, b: str) -> str:
    """Two invoices from one trick: if either got through, the trick worked."""
    return min(a, b, key=RESULT_ORDER.index)


def _invoice_attempts(conn) -> list[dict]:
    rows = conn.execute(
        """SELECT d.document_id, d.filename, d.created_at, u.full_name AS by_name, j.status AS job_status, j.error,
                  i.invoice_id, i.status AS invoice_status, i.vendor_invoice_number, i.total_cents, i.currency,
                  coalesce(v.legal_name, x.fields->>'vendor_name') AS vendor_name
           FROM documents d
           LEFT JOIN extraction_jobs j ON j.document_id = d.document_id
           LEFT JOIN invoices i ON i.document_id = d.document_id
           LEFT JOIN vendors v ON v.vendor_id = i.vendor_id
           LEFT JOIN LATERAL (SELECT fields FROM extractions e WHERE e.document_id = d.document_id
                              ORDER BY extraction_id DESC LIMIT 1) x ON true
           LEFT JOIN users u ON u.user_id = d.uploaded_by
           WHERE d.source = 'upload'
           ORDER BY d.document_id DESC LIMIT 60""").fetchall()
    out = []
    for r in rows:
        reasons = []
        if r["invoice_id"]:
            reasons = [c["message"] for c in conn.execute(
                f"""SELECT message FROM check_results WHERE invoice_id = %s AND severity IN ('block', 'warn')
                    ORDER BY {SEVERITY_ORDER}, check_id""", (r["invoice_id"],))]
        if r["job_status"] in ("queued", "running") or (not r["invoice_id"] and r["job_status"] != "failed"):
            result = "reading"
        elif r["job_status"] == "failed":
            result, reasons = "unreadable", [f"{r['error']} Nothing can be paid from it."]
        elif reasons or r["invoice_status"] in ("on_hold", "needs_review", "rejected"):
            result = "caught"
        else:
            result = "got_through"
        key = fool.scenario_of(r["filename"])
        # The split trick is one attempt made of two invoices ('fool-split-12-1.pdf' and '-2.pdf'): count it once.
        group = r["filename"].rsplit("-", 1)[0] if key == "split" else r["document_id"]
        if out and out[-1]["group"] == group:
            prev = out[-1]
            prev["invoice_ids"].append(r["invoice_id"])
            prev["reasons"] = prev["reasons"] or reasons
            prev["result"] = _worst(prev["result"], result)
            continue
        out.append({"group": group, "invoice_ids": [r["invoice_id"]],
            "id": f"doc-{r['document_id']}", "kind": "invoice", "scenario": key,
            "title": fool.SCENARIOS[key][0] if key else f"Your upload: {r['filename']}",
            "created_at": r["created_at"].isoformat(), "by_name": r["by_name"], "result": result, "reasons": reasons,
            "invoice_id": r["invoice_id"], "invoice_status": r["invoice_status"], "vendor_name": r["vendor_name"],
            "invoice_number": r["vendor_invoice_number"], "total_cents": r["total_cents"], "currency": r["currency"],
            "document_id": r["document_id"],
        })
    for attempt in out:
        del attempt["group"]
    return out


def _bank_change_attempts(conn) -> list[dict]:
    rows = conn.execute(
        """SELECT e.created_at, e.entity_id AS vendor_id, e.after->>'change_id' AS change_id, u.full_name AS by_name,
                  v.legal_name, b.verified_by_callback, b.callback_outcome,
                  (SELECT count(*) FROM check_results c WHERE c.code = 'BANK_CHANGE_UNVERIFIED'
                      AND c.details->>'change_id' = b.change_id) AS held
           FROM audit_events e
           JOIN bank_change_history b ON b.change_id = e.after->>'change_id'
           JOIN vendors v ON v.vendor_id = e.entity_id
           LEFT JOIN users u ON u.user_id = e.actor_user_id
           WHERE e.action = 'vendor.bank_change_requested' AND e.reason LIKE 'Try to fool us%%'
           ORDER BY e.event_id DESC""").fetchall()
    out = []
    for r in rows:
        if r["verified_by_callback"]:
            result, reason = "got_through", "Someone verified it by phone, so the new account is now live."
        else:
            result = "caught"
            held = f" {r['held']} of its invoices are on hold until then." if r["held"] else ""
            reason = (f"The new account was recorded but isn't used: {r['legal_name']} can't be paid until someone else "
                      f"calls them at the phone number on file from before the change.{held}")
        out.append({"id": f"bank-{r['change_id']}", "kind": "bank_change", "scenario": "bank-email",
                    "title": fool.SCENARIOS["bank-email"][0], "created_at": r["created_at"].isoformat(),
                    "by_name": r["by_name"], "result": result, "reasons": [reason], "vendor_id": r["vendor_id"],
                    "vendor_name": r["legal_name"]})
    return out


@router.get("/fool")
def fool_page(conn=Depends(get_conn), user=Depends(current_user)):
    attempts = sorted(_invoice_attempts(conn) + _bank_change_attempts(conn), key=lambda a: a["created_at"], reverse=True)
    done = [a for a in attempts if a["result"] in ("caught", "got_through", "unreadable")]
    return {
        "scenarios": [{"key": k, "title": t, "pitch": p} for k, (t, p) in fool.SCENARIOS.items()],
        "attempts": attempts,
        "caught": sum(a["result"] != "got_through" for a in done),
        "finished": len(done),
        "can_try": can(conn, user, "document.upload").as_dict(),
        # Real invoices that passed every check: edit one (bank account, total, tax...) and upload it.
        "samples": conn.execute(
            """SELECT d.document_id, d.filename, v.legal_name AS vendor_name, i.total_cents, i.currency
               FROM documents d JOIN invoices i USING (document_id) JOIN vendors v USING (vendor_id)
               WHERE d.source = 'email' AND d.mime_type = 'application/pdf' AND i.status = 'pending_approval'
                 AND NOT EXISTS (SELECT 1 FROM check_results c WHERE c.invoice_id = i.invoice_id AND c.severity <> 'info')
               ORDER BY i.total_cents DESC LIMIT 3""").fetchall(),
    }


@router.post("/fool/{key}")
def try_trick(key: str, conn=Depends(get_conn), user=Depends(current_user)):
    if key not in fool.SCENARIOS:
        raise HTTPException(404, "Unknown trick")
    decision = can(conn, user, "document.upload")
    if not decision.allowed:
        raise HTTPException(403, decision.reason)
    with conn.transaction():
        return fool.launch(conn, key, user)
