"""Document -> fields + a confidence per field.

Confidence is calculated, not guessed by a model:
  * text-layer PDF, value found and well-formed ............ 0.99
  * OCR, all passes agree, well-formed ....................... 0.90
  * OCR, passes disagree (the well-formed majority is used) .. 0.60, with the readings listed
  * found but malformed (e.g. a 4-digit transit) ............. 0.40
  * not found ................................................ 0
Anything under REVIEW_THRESHOLD sends the invoice to a person, who sees why.
"""

import re
from collections import Counter

from app.extraction.parser import parse
from app.extraction.sources import field_sources
from app.extraction.text import read_document

REVIEW_THRESHOLD = 0.8

FORMATS = {
    "vendor_gst": (re.compile(r"^\d{9}RT\d{4}$"), "a GST/HST number is 9 digits, RT, then 4 digits"),
    "vendor_qst": (re.compile(r"^\d{10}TQ\d{4}$"), "a QST number is 10 digits, TQ, then 4 digits"),
    "bank_institution": (re.compile(r"^\d{3}$"), "an institution number is 3 digits"),
    "bank_transit": (re.compile(r"^\d{5}$"), "a transit number is 5 digits"),
    "bank_account": (re.compile(r"^\d{7,12}$"), "an account number is 7 to 12 digits"),
    "invoice_number": (re.compile(r"^[A-Z0-9][A-Z0-9\-/]*$", re.I), "letters, digits and dashes"),
}
SCALAR_FIELDS = ["vendor_name", "vendor_gst", "vendor_qst", "invoice_number", "invoice_date", "due_date", "terms",
                 "credit_note_ref", "bill_to_province", "currency", "document_type", "bank_institution",
                 "bank_transit", "bank_account", "language"]
# Without these an invoice can't move on by itself. (The vendor is matched separately, in pipeline.py.)
REQUIRED = ["vendor_name", "invoice_number", "invoice_date", "total_cents", "lines"]

LABELS = {
    "vendor_name": "Vendor name", "vendor_gst": "GST/HST number", "vendor_qst": "QST number",
    "invoice_number": "Invoice number", "invoice_date": "Invoice date", "due_date": "Due date",
    "bank_institution": "Institution", "bank_transit": "Transit", "bank_account": "Account",
    "total_cents": "Total", "lines": "Lines", "subtotal_cents": "Subtotal",
}


def well_formed(field: str, value) -> bool:
    rule = FORMATS.get(field)
    return rule is None or bool(rule[0].match(str(value)))


def _amounts_consistent(p: dict) -> bool:
    if not p["lines"] or p["subtotal_cents"] is None or p["total_cents"] is None:
        return False
    lines_ok = sum(line["amount_cents"] for line in p["lines"]) == p["subtotal_cents"]
    total_ok = p["subtotal_cents"] + sum(t["amount_cents"] for t in p["taxes"]) == p["total_cents"]
    return lines_ok and total_ok


def merge(parses: list[dict], engine: str) -> tuple[dict, dict]:
    """Combine one parse (text layer) or several (OCR passes) into fields + per-field confidence."""
    fields: dict = {}
    confidence: dict = {}
    base = 0.99 if engine == "text_layer" else 0.90

    for field in SCALAR_FIELDS:
        readings = [p[field] for p in parses if p.get(field)]
        if not readings:
            fields[field] = None
            # A missing optional field (most invoices have no QST number) is not a doubt about the reading.
            confidence[field] = ({"score": 0.0, "note": "Not found on the document"} if field in REQUIRED
                                 else {"score": None, "note": "Not on the document"})
            continue
        good = [r for r in readings if well_formed(field, r)]
        value = Counter(good or readings).most_common(1)[0][0]
        fields[field] = value
        if not well_formed(field, value):
            confidence[field] = {"score": 0.4, "note": f"“{value}” doesn't look right: {FORMATS[field][1]}"}
        elif len(set(readings)) > 1:
            shown = ", ".join(f"“{r}”" for r in readings)
            confidence[field] = {"score": 0.6,
                                 "note": f"The OCR passes disagreed ({shown}); we used “{value}”. Please confirm."}
        elif len(readings) < len(parses):
            confidence[field] = {"score": 0.75, "note": "Only some OCR passes found this. Please confirm."}
        else:
            confidence[field] = {"score": base, "note": "Read from the PDF's text" if engine == "text_layer"
                                 else "All OCR passes agree"}

    # Amounts come as a block from one reading, preferring a reading whose own arithmetic adds up.
    # (If none adds up, the invoice itself may be wrong; the maths checks will say so.)
    best = next((p for p in parses if _amounts_consistent(p)), None)
    consistent = best is not None
    best = best or max(parses, key=lambda p: (len(p["lines"]), p["total_cents"] is not None))
    for field in ("lines", "subtotal_cents", "taxes", "total_cents"):
        fields[field] = best[field]
    amount_score = base if consistent else (base if engine == "text_layer" else 0.6)
    amount_note = ("Read from the PDF's text" if engine == "text_layer"
                   else "Lines, taxes and total add up" if consistent
                   else "These numbers don't add up and came from OCR. Check them against the original.")
    for field in ("lines", "subtotal_cents", "total_cents"):
        missing = fields[field] in (None, [])
        confidence[field] = {"score": 0.0 if missing else amount_score,
                             "note": "Not found on the document" if missing else amount_note}

    return fields, confidence


def overall(confidence: dict) -> float:
    return min(confidence[f]["score"] for f in REQUIRED)


def doubtful_fields(confidence: dict) -> list[str]:
    """Fields a person should look at: present but uncertain, or required and missing."""
    return [f for f, c in confidence.items() if c["score"] is not None and c["score"] < REVIEW_THRESHOLD]


def extract(content: bytes, mime_type: str) -> dict:
    engine, texts = read_document(content, mime_type)
    parses = [parse(t) for t in texts]
    fields, confidence = merge(parses, engine)
    return {"engine": engine, "raw_text": "\n\n──── next OCR pass ────\n\n".join(texts),
            "fields": fields, "confidence": confidence,
            "field_sources": _sources(content, mime_type, engine, parses, fields)}


def _sources(content: bytes, mime_type: str, engine: str, parses: list[dict], fields: dict) -> list[dict]:
    # DECISION: the boxes are a reading aid, found after the fields were read. If finding them fails, the invoice
    # is still read and checked; it just shows no highlights. Rejected: failing the whole document over it.
    try:
        return field_sources(content, mime_type, engine, parses, fields)
    except Exception as exc:  # noqa: BLE001 - logged, never fatal
        print(f"field sources not found: {type(exc).__name__}: {exc}", flush=True)
        return []
