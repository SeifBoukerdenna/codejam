"""Intake: sort the AP inbox and queue every invoice document for reading.

Sorting is keyword rules, checked in this order (first match wins):
  has an attachment               -> invoice (one document per attachment: an email can carry several)
  "statement of account"          -> statement: filed, no invoice
  sale / unsubscribe / news@...   -> newsletter: ignored
  "where is payment" / status     -> payment question: answered from our payment records
  says "attached" but nothing is  -> missing attachment: ask the sender to resend
  anything else                   -> other: left for a person
"""

import hashlib
import mimetypes
import re

from app import audit, config
from app.checks.duplicates import normalize_invoice_number
from app.money import fmt

RULES = [
    ("statement", re.compile(r"statement of account|relev[ée] de compte", re.I)),
    ("newsletter", re.compile(r"unsubscribe|newsletter|\bsale\b|% off|shop now|promo", re.I)),
    ("payment_inquiry", re.compile(r"where is (?:the |my )?payment|payment status|not (?:yet )?(?:seen|received) payment"
                                   r"|confirm the status|statut du paiement|o[uù] en est le paiement", re.I)),
    ("missing_attachment", re.compile(r"attached|attachment|ci-joint|pi[èe]ce jointe", re.I)),
]
NEWSLETTER_SENDERS = re.compile(r"^(news|newsletter|marketing|promo|no-?reply)@", re.I)
INVOICE_REF_RE = re.compile(r"invoice\s*#?\s*([A-Z0-9][A-Z0-9\-]*\d)", re.I)


def classify(email: dict) -> str:
    if email["attachments"]:
        return "invoice"
    if NEWSLETTER_SENDERS.match(email["from_address"]):
        return "newsletter"
    text = f"{email['subject']}\n{email['body']}"
    for name, pattern in RULES:
        if pattern.search(text):
            return name
    return "other"


def answer_payment_question(conn, email: dict) -> str:
    """Look up the invoice the vendor is asking about and say what happened to it."""
    ref = INVOICE_REF_RE.search(f"{email['subject']} {email['body']}")
    if not ref:
        return "Asks about a payment but names no invoice number. Reply asking which invoice."
    number = ref.group(1)
    vendor = conn.execute("SELECT * FROM vendors WHERE lower(ap_contact_email) = lower(%s) ORDER BY vendor_id LIMIT 1",
                          (email["from_address"],)).fetchone()
    candidates = conn.execute(
        "SELECT * FROM invoices WHERE vendor_id = %s AND NOT is_credit_note", (vendor["vendor_id"] if vendor else None,)
    ).fetchall()
    invoice = next((i for i in candidates
                    if normalize_invoice_number(i["vendor_invoice_number"]) == normalize_invoice_number(number)), None)
    if not invoice:
        return f"Asks about invoice {number}, which we have no record of. Ask the vendor to send it."
    pay = conn.execute(
        "SELECT * FROM payments WHERE invoice_id = %s AND status <> 'cancelled' ORDER BY payment_id DESC LIMIT 1",
        (invoice["invoice_id"],)).fetchone()
    if pay and pay["status"] == "settled":
        return (f"Invoice {number} ({invoice['invoice_id']}) was already paid: {pay['payment_id']}, "
                f"{pay['method']}, {fmt(pay['amount_cents'], pay['currency'])}, settled {pay['paid_date']:%B %-d, %Y} "
                f"(ref {pay['reference']}). Reply with these details.")
    if pay:
        return f"Invoice {number} ({invoice['invoice_id']}) has payment {pay['payment_id']} ({pay['status']})."
    return f"Invoice {number} ({invoice['invoice_id']}) isn't paid yet; status: {invoice['status'].replace('_', ' ')}."


NOTES = {
    "statement": "Statement of account. Filed for reference; no invoice created.",
    "newsletter": "Marketing email. Ignored.",
    "missing_attachment": "Says an invoice is attached, but nothing is. Reply asking the sender to resend it.",
    "other": "Not an invoice. Left for a person to read.",
}


def store_document(conn, *, filename: str, content: bytes, source: str, email_id: str | None = None,
                   uploaded_by: str | None = None) -> tuple[int, bool]:
    """Save a file and queue it for reading. Returns (document_id, is_new); the same bytes twice = one document."""
    sha = hashlib.sha256(content).hexdigest()
    existing = conn.execute("SELECT document_id FROM documents WHERE sha256 = %s", (sha,)).fetchone()
    if existing:
        return existing["document_id"], False
    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    doc = conn.execute(
        """INSERT INTO documents (filename, mime_type, sha256, content, source, email_id, uploaded_by)
           VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING document_id""",
        (filename, mime, sha, content, source, email_id, uploaded_by)).fetchone()
    conn.execute("INSERT INTO extraction_jobs (document_id) VALUES (%s)", (doc["document_id"],))
    audit.log(conn, actor=uploaded_by, action="document.received", entity_type="document",
              entity_id=str(doc["document_id"]), after={"filename": filename, "source": source, "email_id": email_id},
              reason="Queued for reading")
    return doc["document_id"], True


def process_inbox(conn, actor: str) -> dict:
    counts: dict[str, int] = {}
    for email in conn.execute("SELECT * FROM emails WHERE intake_status = 'unprocessed' ORDER BY received_at").fetchall():
        kind = classify(email)
        if kind == "invoice":
            queued = 0
            for name in email["attachments"]:
                path = config.DATA_DIR / "incoming_invoices" / name
                if not path.is_file():
                    continue
                _, new = store_document(conn, filename=name, content=path.read_bytes(), source="email",
                                        email_id=email["email_id"], uploaded_by=actor)
                queued += new
            note = f"{queued} invoice document{'s' if queued != 1 else ''} queued for reading."
        elif kind == "payment_inquiry":
            note = answer_payment_question(conn, email)
        else:
            note = NOTES[kind]
        conn.execute(
            """UPDATE emails SET classification = %s, intake_status = 'processed', intake_note = %s, processed_at = now()
               WHERE email_id = %s""", (kind, note, email["email_id"]))
        audit.log(conn, actor=actor, action="email.sorted", entity_type="email", entity_id=email["email_id"],
                  after={"classification": kind}, reason=note)
        counts[kind] = counts.get(kind, 0) + 1
    return counts
