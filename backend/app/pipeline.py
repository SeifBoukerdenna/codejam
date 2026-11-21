"""From a document to an invoice that is coded, checked and (if clean) on its way to approval.

    process_document  read it -> create the invoice -> code it -> evaluate it
    evaluate          run every check, store the reasons, then decide the status:
                        any 'block'                          -> on_hold      (can't proceed)
                        unacknowledged 'warn', doubtful fields,
                        or missing department/requester      -> needs_review (a person looks)
                        otherwise                            -> pending_approval (routed, P01–P08)

DECISION: a brand-new invoice that is completely clean goes straight to approval ("touchless"). Anything a
person had to look at only moves on when that person clicks Submit, which also records that they confirmed
the fields.
"""

from decimal import Decimal

from psycopg.types.json import Jsonb

from app import audit, coding, config
from app.money import apply_rate
from app.checks.context import build_context
from app.checks.run import run_checks
from app.extraction.extract import LABELS, doubtful_fields, extract
from app.vendor_match import match_vendor
from app.workflow import approvals

EDITABLE_STATUSES = ("extracting", "needs_review", "on_hold", "pending_approval")


def new_invoice_id(conn) -> str:
    n = conn.execute("SELECT nextval('invoice_number_seq') AS n").fetchone()["n"]
    return f"AP-{n:05d}"


def fx_rate(conn, currency: str, on_date) -> Decimal:
    """USD -> CAD at the rate on the invoice date (the latest rate on or before it)."""
    if currency == "CAD":
        return Decimal(1)
    row = conn.execute("SELECT usd_to_cad FROM fx_rates WHERE date <= %s ORDER BY date DESC LIMIT 1",
                       (on_date or config.TODAY,)).fetchone()
    return row["usd_to_cad"]


def create_invoice(conn, document: dict, extraction: dict) -> str:
    fields = extraction["fields"]
    sender = None
    if document["email_id"]:
        sender = conn.execute("SELECT from_address FROM emails WHERE email_id = %s",
                              (document["email_id"],)).fetchone()["from_address"]
    vendor_id, how = match_vendor(conn, fields, sender)
    vendor = conn.execute("SELECT * FROM vendors WHERE vendor_id = %s", (vendor_id,)).fetchone() if vendor_id else None

    currency = fields["currency"] or "CAD"
    rate = fx_rate(conn, currency, fields["invoice_date"])
    total = fields["total_cents"]
    by_kind = {"gst_hst": 0, "pst_qst": 0}
    codes = {"gst_hst": None, "pst_qst": None}
    for tax in fields["taxes"]:
        by_kind[tax["kind"]] += tax["amount_cents"]
        codes[tax["kind"]] = codes[tax["kind"]] or tax["code"]
    if not fields["taxes"] and vendor:
        codes["gst_hst"] = "FOREIGN" if vendor["country"] != "CA" else "EXEMPT" if vendor["category"] == "Insurance" else None

    received = config.TODAY
    if document["email_id"]:
        received = conn.execute("SELECT received_at::date AS d FROM emails WHERE email_id = %s",
                                (document["email_id"],)).fetchone()["d"]
    invoice_id = new_invoice_id(conn)
    conn.execute(
        """INSERT INTO invoices (invoice_id, vendor_id, vendor_invoice_number, invoice_date, received_date, due_date,
                                 currency, subtotal_cents, gst_hst_cents, pst_qst_cents, total_cents, fx_rate_to_cad,
                                 total_cad_cents, ship_to_province, status, source, document_id, email_id, is_credit_note)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'extracting', %s, %s, %s, %s)""",
        (invoice_id, vendor_id, fields["invoice_number"], fields["invoice_date"], received, fields["due_date"],
         currency, fields["subtotal_cents"], by_kind["gst_hst"], by_kind["pst_qst"], total, rate,
         apply_rate(total, rate) if total is not None else None, fields["bill_to_province"],
         document["source"], document["document_id"], document["email_id"], fields["document_type"] == "credit_note"))
    for i, line in enumerate(fields["lines"], start=1):
        conn.execute(
            """INSERT INTO invoice_lines (invoice_id, line_no, description, quantity, unit_price_cents, amount_cents,
                                          gst_hst_code, pst_qst_code)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
            (invoice_id, i, line["description"], Decimal(line["quantity"]), line["unit_price_cents"],
             line["amount_cents"], codes["gst_hst"], codes["pst_qst"]))

    # Coding needs the matched PO (department and requester come from it), which the checks' context finds.
    ctx = build_context(conn, invoice_id)
    suggestion = coding.suggest(conn, vendor, ctx["lines"], ctx["po"])
    for i, coded in enumerate(suggestion["lines"], start=1):
        conn.execute(
            """UPDATE invoice_lines SET gl_account = %s, department_id = %s, line_type = %s, coding_reason = %s
               WHERE invoice_id = %s AND line_no = %s""",
            (coded["gl_account"], suggestion["department_id"], coded["line_type"], coded["coding_reason"],
             invoice_id, i))
    conn.execute("UPDATE invoices SET department_id = %s, requester_user_id = %s WHERE invoice_id = %s",
                 (suggestion["department_id"], suggestion["requester_user_id"], invoice_id))

    audit.log(conn, actor=None, action="invoice.create", entity_type="invoice", entity_id=invoice_id,
              after={"document_id": document["document_id"], "vendor_id": vendor_id, "number": fields["invoice_number"],
                     "total_cents": total, "currency": currency, "department_id": suggestion["department_id"],
                     "requester_user_id": suggestion["requester_user_id"]},
              reason=f"Read from {document['filename']} ({extraction['engine'].replace('_', ' ')}). Vendor: {how}. "
                     f"Department: {suggestion['department_reason']}. Requester: {suggestion['requester_reason']}.")
    return invoice_id


def _store_results(conn, invoice_id: str, results) -> None:
    """Replace the check results, keeping acknowledgements of warnings that are still the same."""
    acked = {(r["code"], r["message"]): r for r in conn.execute(
        "SELECT * FROM check_results WHERE invoice_id = %s AND acknowledged_by IS NOT NULL", (invoice_id,))}
    conn.execute("DELETE FROM check_results WHERE invoice_id = %s", (invoice_id,))
    for r in results:
        kept = acked.get((r.code, r.message))
        conn.execute(
            """INSERT INTO check_results (invoice_id, code, severity, message, details, acknowledged_by, acknowledged_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (invoice_id, r.code, r.severity, r.message, Jsonb(audit._plain(r.details)),
             kept["acknowledged_by"] if kept else None, kept["acknowledged_at"] if kept else None))


def review_reasons(conn, invoice: dict, results: list[dict]) -> list[str]:
    """Why a person has to look at this invoice before it can be submitted. Empty = ready."""
    reasons = [f"Acknowledge: {r['message']}" for r in results if r["severity"] == "warn" and not r["acknowledged_by"]]
    if invoice["document_id"] and not invoice["reviewed_by"]:
        row = conn.execute("SELECT field_confidence AS confidence FROM extractions WHERE document_id = %s ORDER BY extraction_id DESC LIMIT 1",
                           (invoice["document_id"],)).fetchone()
        doubtful = doubtful_fields(row["confidence"]) if row else []
        if doubtful:
            reasons.append("Confirm what we read: " + ", ".join(LABELS.get(f, f) for f in doubtful) + " (low confidence).")
    if not invoice["department_id"]:
        reasons.append("Choose the department this is charged to.")
    if not invoice["requester_user_id"]:
        reasons.append("Choose who requested it.")
    return reasons


def evaluate(conn, invoice_id: str, *, actor: str | None = None, reason: str = "Checks re-run",
             submit: bool = False, cascade: bool = True) -> dict:
    ctx, results = run_checks(conn, invoice_id)
    inv = ctx["invoice"]
    po_id = ctx["po"]["po_id"] if ctx["po"] else None
    contract_id = ctx["contract"]["contract_id"] if ctx["contract"] else None
    if (po_id, contract_id) != (inv["po_id"], inv["contract_id"]) and inv["status"] in EDITABLE_STATUSES:
        conn.execute("UPDATE invoices SET po_id = %s, contract_id = %s WHERE invoice_id = %s",
                     (po_id, contract_id, invoice_id))
    _store_results(conn, invoice_id, results)
    if inv["status"] not in EDITABLE_STATUSES:
        return {"status": inv["status"], "reasons": []}

    acted = conn.execute("SELECT 1 FROM approvals WHERE invoice_id = %s AND action <> 'pending'",
                         (invoice_id,)).fetchone()
    if inv["status"] == "pending_approval" and acted:
        return {"status": inv["status"], "reasons": []}   # already in someone's hands; payment blockers still apply

    if submit and actor:
        conn.execute("UPDATE invoices SET reviewed_by = %s, reviewed_at = now() WHERE invoice_id = %s", (actor, invoice_id))
        inv = {**inv, "reviewed_by": actor}
    stored = conn.execute("SELECT * FROM check_results WHERE invoice_id = %s", (invoice_id,)).fetchall()
    blocks = [r for r in results if r.severity == "block"]
    reasons = review_reasons(conn, inv, stored)

    if blocks:
        target = "on_hold"
        hold = blocks[0].message + (f" (+{len(blocks) - 1} more)" if len(blocks) > 1 else "")
    elif reasons:
        target, hold = "needs_review", None
    elif submit or inv["status"] in ("extracting", "pending_approval"):
        target, hold = "pending_approval", None
    else:
        target, hold = "needs_review", None

    if inv["status"] == "pending_approval" and target != "pending_approval":
        approvals.withdraw(conn, invoice_id, actor, f"New information: {hold or '; '.join(reasons)}")
    if target == "pending_approval" and inv["status"] != "pending_approval":
        approvals.submit(conn, inv, {r.code for r in results}, ctx["vendor"], actor,
                         "Submitted after review" if submit else "All checks passed and every field was read with "
                         "high confidence, so it went straight to approval")
    elif target != inv["status"] or hold != inv["hold_reason"]:
        conn.execute("UPDATE invoices SET status = %s, hold_reason = %s WHERE invoice_id = %s", (target, hold, invoice_id))
        audit.log(conn, actor=actor, action=f"invoice.{target}", entity_type="invoice", entity_id=invoice_id,
                  before={"status": inv["status"]}, after={"status": target}, reason=hold or "; ".join(reasons) or reason)

    # A new invoice can change the picture for its siblings (e.g. the third of three split invoices).
    if cascade:
        for r in results:
            for related in r.details.get("related", []):
                evaluate(conn, related, actor=actor, reason=f"Re-checked because {invoice_id} arrived", cascade=False)
    return {"status": target, "reasons": [b.message for b in blocks] + reasons}


def process_document(conn, document_id: int) -> str:
    document = conn.execute("SELECT * FROM documents WHERE document_id = %s", (document_id,)).fetchone()
    result = extract(bytes(document["content"]), document["mime_type"])
    conn.execute(
        """INSERT INTO extractions (document_id, engine, raw_text, fields, field_confidence, field_sources)
           VALUES (%s, %s, %s, %s, %s, %s)""",
        (document_id, result["engine"], result["raw_text"], Jsonb(result["fields"]), Jsonb(result["confidence"]),
         Jsonb(result["field_sources"])))
    invoice_id = create_invoice(conn, document, result)
    evaluate(conn, invoice_id, reason=f"New invoice read from {document['filename']}")
    return invoice_id
