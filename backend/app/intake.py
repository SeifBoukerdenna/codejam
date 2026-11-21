"""Intake: sort the AP inbox and queue every invoice document for reading.

Sorting is keyword rules, checked in this order (first match wins):
  has an attachment               -> invoice (one document per attachment: an email can carry several)
  "statement of account"          -> statement: filed, no invoice
  sale / unsubscribe / news@...   -> newsletter: ignored
  "where is payment" / status     -> payment question: answered from our payment records
  says "attached" but nothing is  -> missing attachment: ask the sender to resend
  anything else                   -> other: left for a person

For payment questions and missing attachments we also write a ready-to-send reply. It's built from our own
records with plain string templates (no AI), so every fact in it can be traced to a payment or invoice row.
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
METHOD_WORDS = {"EFT": "Bank transfer (EFT)", "CHEQUE": "Cheque", "CARD": "Virtual card"}
SIGNATURE = "Accounts Payable · Harborline Logistics\nap@harborline-logistics.example"

NOTES = {
    "statement": "Statement of account. Filed for reference; no invoice created.",
    "newsletter": "Marketing email. Ignored.",
    "missing_attachment": "Says an invoice is attached, but nothing is. A reply asking to resend it is ready.",
    "other": "Not an invoice. Left for a person to read.",
}


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


def _greeting(conn, email: dict) -> str:
    vendor = conn.execute("SELECT legal_name FROM vendors WHERE lower(ap_contact_email) = lower(%s) ORDER BY vendor_id LIMIT 1",
                          (email["from_address"],)).fetchone()
    if vendor:
        return f"Hi {vendor['legal_name']} team,"
    name = re.sub(r"\s+(Accounts Receivable|AR|Billing)$", "", email["from_name"] or "", flags=re.I).strip()
    return f"Hi {name}," if name else "Hello,"


def _sign(signer: str) -> str:
    return f"Best regards,\n{signer}\n{SIGNATURE}"


def answer_payment_question(conn, email: dict, signer: str) -> tuple[str, str]:
    """Look up the invoice the vendor asks about. Returns (note for AP, reply to send the vendor)."""
    hello = _greeting(conn, email)
    ref = INVOICE_REF_RE.search(f"{email['subject']} {email['body']}")
    if not ref:
        return ("Asks about a payment but names no invoice number. A reply asking which invoice is ready.",
                f"{hello}\n\nThanks for your message. Could you tell us which invoice number you're asking about? "
                f"We'll check its status right away.\n\n{_sign(signer)}")
    number = ref.group(1)
    vendor = conn.execute("SELECT * FROM vendors WHERE lower(ap_contact_email) = lower(%s) ORDER BY vendor_id LIMIT 1",
                          (email["from_address"],)).fetchone()
    candidates = conn.execute("SELECT * FROM invoices WHERE vendor_id = %s AND NOT is_credit_note",
                              (vendor["vendor_id"] if vendor else None,)).fetchall()
    invoice = next((i for i in candidates
                    if normalize_invoice_number(i["vendor_invoice_number"]) == normalize_invoice_number(number)), None)
    if not invoice:
        return (f"Asks about invoice {number}, which we have no record of. A reply asking for a copy is ready.",
                f"{hello}\n\nThanks for checking in. We don't have invoice {number} on file. Could you send us a copy "
                f"at ap@harborline-logistics.example? We'll process it as soon as it arrives.\n\n{_sign(signer)}")

    pay = conn.execute("SELECT * FROM payments WHERE invoice_id = %s AND status <> 'cancelled' ORDER BY payment_id DESC LIMIT 1",
                       (invoice["invoice_id"],)).fetchone()
    if pay and pay["status"] in ("settled", "outstanding"):
        when = f"{pay['paid_date']:%B %-d, %Y}"
        note = (f"Invoice {number} ({invoice['invoice_id']}) was already paid: {pay['payment_id']}, {pay['method']}, "
                f"{fmt(pay['amount_cents'], pay['currency'])}, settled {when} (ref {pay['reference']}). A reply is ready.")
        cashed = "" if pay["status"] == "settled" else " The cheque hasn't been cashed yet on our side."
        reply = (f"{hello}\n\nThanks for checking in. Invoice {number} was paid in full on {when}.{cashed}\n\n"
                 f"Amount: {fmt(pay['amount_cents'], pay['currency'])}\n"
                 f"Method: {METHOD_WORDS.get(pay['method'], pay['method'])}\n"
                 f"Reference: {pay['reference']}\n\n"
                 f"If you can't find it on your side, reply with your remittance details and we'll trace it with "
                 f"our bank.\n\n{_sign(signer)}")
        return note, reply
    if pay:
        when = f"{pay['scheduled_date']:%B %-d, %Y}" if pay["scheduled_date"] else "shortly"
        return (f"Invoice {number} ({invoice['invoice_id']}) has payment {pay['payment_id']} ({pay['status']}). A reply is ready.",
                f"{hello}\n\nThanks for checking in. Invoice {number} is approved and its payment of "
                f"{fmt(pay['amount_cents'], pay['currency'])} is scheduled for {when} by "
                f"{METHOD_WORDS.get(pay['method'], pay['method']).lower()}.\n\n{_sign(signer)}")
    due = f" It's due on {invoice['due_date']:%B %-d, %Y}." if invoice["due_date"] else ""
    return (f"Invoice {number} ({invoice['invoice_id']}) isn't paid yet; status: {invoice['status'].replace('_', ' ')}. "
            f"A reply is ready.",
            f"{hello}\n\nThanks for checking in. We have invoice {number} and it's going through our approval "
            f"process.{due} We'll pay it on time.\n\n{_sign(signer)}")


def missing_attachment_reply(conn, email: dict, signer: str) -> str:
    return (f"{_greeting(conn, email)}\n\nThanks for your email. It mentions an invoice, but nothing was attached on "
            f"our side. Could you send it again as a PDF?\n\n{_sign(signer)}")


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
    signer = conn.execute("SELECT full_name FROM users WHERE user_id = %s", (actor,)).fetchone()["full_name"]
    counts: dict[str, int] = {}
    for email in conn.execute("SELECT * FROM emails WHERE intake_status = 'unprocessed' ORDER BY received_at").fetchall():
        kind = classify(email)
        reply = None
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
            note, reply = answer_payment_question(conn, email, signer)
        elif kind == "missing_attachment":
            note, reply = NOTES[kind], missing_attachment_reply(conn, email, signer)
        else:
            note = NOTES[kind]
        conn.execute(
            """UPDATE emails SET classification = %s, intake_status = 'processed', intake_note = %s, reply_draft = %s,
                      processed_at = now() WHERE email_id = %s""", (kind, note, reply, email["email_id"]))
        audit.log(conn, actor=actor, action="email.sorted", entity_type="email", entity_id=email["email_id"],
                  after={"classification": kind, "reply_drafted": reply is not None}, reason=note)
        counts[kind] = counts.get(kind, 0) + 1
    return counts
