"""Turn the text of one invoice into fields. Pure functions, no database, no AI: every field is found by a
labelled regular expression, so for any value on screen we can point at the rule that read it.

Handles English and French labels, both number styles ($1,014.18 and 1 014,18 $), credit notes, and the
stray characters OCR adds ("‘Subtotal"). It reads what is PRINTED: if the invoice's own maths is wrong, the
wrong numbers are kept, and the checks flag them later.
"""

import re
from datetime import date

from app.money import to_cents

HARBORLINE_GST = "100000001RT0001"  # our own number, printed in every "Bill to" block; never the vendor's

# One money amount: optional minus and $, digit groups split by , or a space, then 2 decimals with . or ,
AMOUNT = r"-?\$?\s?-?\d{1,3}(?:[,   ]\d{3})*[.,]\d{2}(?:\s?\$)?"

LINE_RE = re.compile(rf"^(?P<desc>.+?)\s+(?P<qty>\d+(?:[.,]\d+)?)\s+(?P<unit>{AMOUNT})\s+(?P<amount>{AMOUNT})\s*$")
SUBTOTAL_RE = re.compile(rf"^(?:sub-?total|sous-total)\b\s*:?\s*(?P<amt>{AMOUNT})", re.I)
TAX_RE = re.compile(rf"^(?P<label>[A-Za-z/]{{1,8}})\s*\((?P<rate>\d+(?:[.,]\d+)?)\s*%\)\s*:?\s*(?P<amt>{AMOUNT})")
TOTAL_RE = re.compile(rf"^total\b(?:\s+(?P<cur>CAD|USD))?\s*:?\s*(?P<amt>{AMOUNT})", re.I)

INVOICE_NO_RE = re.compile(
    r"(?:\bINV(?:OICE)?\s*(?:NO\.?|#|NUMBER)|\bFacture\s*n[°o]|\bN[°o]\s*de\s*facture)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/]*)",
    re.I)
INVOICE_DATE_RE = re.compile(r"(?<!due )\b(?:invoice\s+)?(?:date|issued)\s*:\s*(\d{4}-\d{2}-\d{2})", re.I)
DUE_DATE_RE = re.compile(r"(?:due\s*date|payment\s*due|due\s*by|\bdue|[ée]ch[ée]ance)\s*:\s*(\d{4}-\d{2}-\d{2})", re.I)
TERMS_RE = re.compile(r"(?:payment\s+)?(?:terms|conditions)\s*:\s*([^\n]+?)\s*$", re.I | re.M)
CREDIT_NOTE_RE = re.compile(r"CREDIT\s+NOTE|NOTE\s+DE\s+CR[ÉE]DIT", re.I)
CREDIT_REF_RE = re.compile(r"credit\s+note\s+ref\s*:\s*(\S+)", re.I)
BILL_TO_RE = re.compile(r"^\s*(?:bill\s+to|facturer\s+[àa]|factur[ée]\s+[àa])\b", re.I | re.M)
GST_RE = re.compile(r"(?:GST/HST|TPS/TVH|GST|HST|TPS)\s*(?:No\.?|#|number)?\s*[:.]?\s*([0-9A-Z!|]{9}\s?RT\s?[0-9A-Z!|]{4})", re.I)
QST_RE = re.compile(r"(?:QST|TVQ)\s*(?:No\.?|#)?\s*[:.]?\s*(\d{10}\s?TQ\s?\d{4})", re.I)
PROVINCE_RE = re.compile(r"\b(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\s+[A-Z]\d[A-Z]")
REMIT_RE = re.compile(r"Inst\.?\s*:?\s*(\S+)\s+Transit\s*:?\s*(\S+)\s+Acc(?:oun)?t\.?\s*:?\s*(\S+)", re.I)
TITLE_WORDS_RE = re.compile(r"\s+(TAX\s+INVOICE|INVOICE|FACTURE|CREDIT\s+NOTE)\s*$", re.I)

# Tax lines are recognised by their RATE first: OCR read "QST (9.975%)" as "ST (9.975%)" on a real scan,
# but the rate survives. kind = which invoice column the amount goes to.
TAX_BY_RATE = {
    "13": ("gst_hst", "HST13"),
    "5": ("gst_hst", "GST5"),
    "9.975": ("pst_qst", "QST9975"),
    "7": ("pst_qst", "PST7_BC"),
}
GST_LIKE_LABELS = {"GST", "HST", "TPS", "TVH", "GST/HST", "TPS/TVH"}


def parse_amount(text: str) -> int:
    """'$1,014.18' / '1 014,18 $' / '-$1,042.76' -> cents."""
    negative = "-" in text
    digits = re.sub(r"[^\d,.]", "", text)
    if re.search(r",\d{2}$", digits):   # French style: comma is the decimal mark
        digits = digits.replace(".", "").replace(",", ".")
    else:
        digits = digits.replace(",", "")
    cents = to_cents(digits)
    return -cents if negative else cents


def _clean(line: str) -> str:
    """Strip OCR debris before a label: "‘Subtotal" -> "Subtotal"."""
    return re.sub(r"^[^\w$-]+", "", line.strip())


def _iso_date(text: str | None) -> str | None:
    if not text:
        return None
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError:
        return None


def _tax(label: str, rate_text: str, amount_cents: int) -> dict:
    rate = rate_text.replace(",", ".")
    rate = rate.rstrip("0").rstrip(".") if "." in rate else rate
    kind, code = TAX_BY_RATE.get(rate, (None, None))
    if kind is None:  # unusual rate: fall back to the label
        kind = "gst_hst" if label.upper() in GST_LIKE_LABELS else "pst_qst"
    return {"label": label.upper(), "rate_pct": rate, "amount_cents": amount_cents, "kind": kind, "code": code}


def parse(text: str) -> dict:
    lines = [ln.rstrip() for ln in text.splitlines()]
    fields: dict = {}

    # ── who sent it: everything above "Bill to" ──
    bill_to = BILL_TO_RE.search(text)
    vendor_block = text[: bill_to.start()] if bill_to else text[:600]
    first = next((ln.strip() for ln in lines if ln.strip()), "")
    fields["vendor_name"] = TITLE_WORDS_RE.sub("", first).split("  ")[0].strip() or None
    gst = next((g.replace(" ", "").upper() for g in GST_RE.findall(vendor_block)
                if g.replace(" ", "").upper() != HARBORLINE_GST), None)
    fields["vendor_gst"] = gst
    qst = QST_RE.search(vendor_block)
    fields["vendor_qst"] = qst.group(1).replace(" ", "") if qst else None

    # ── where it is delivered: the province in the Bill-to address decides the tax ──
    fields["bill_to_province"] = None
    if bill_to:
        block = text[bill_to.end(): bill_to.end() + 300]
        province = PROVINCE_RE.search(block)
        fields["bill_to_province"] = province.group(1) if province else None

    # ── header ──
    number = INVOICE_NO_RE.search(text)
    fields["invoice_number"] = number.group(1) if number else None
    invoice_date = INVOICE_DATE_RE.search(text)
    fields["invoice_date"] = _iso_date(invoice_date.group(1) if invoice_date else None)
    due = DUE_DATE_RE.search(text)
    fields["due_date"] = _iso_date(due.group(1) if due else None)
    terms = TERMS_RE.search(text)
    fields["terms"] = terms.group(1).strip() if terms else None
    ref = CREDIT_REF_RE.search(text)
    fields["credit_note_ref"] = ref.group(1) if ref and ref.group(1) != fields["invoice_number"] else None

    # ── lines, from the "Description" header down to the subtotal ──
    start = next((i for i, ln in enumerate(lines) if re.search(r"\bdescription\b", ln, re.I)), 0)
    fields["lines"] = []
    fields["subtotal_cents"] = None
    fields["taxes"] = []
    fields["total_cents"] = None
    fields["currency"] = None
    for raw in lines[start:]:
        line = _clean(raw)
        if m := SUBTOTAL_RE.match(line):
            fields["subtotal_cents"] = parse_amount(m.group("amt"))
        elif m := TAX_RE.match(line):
            fields["taxes"].append(_tax(m.group("label"), m.group("rate"), parse_amount(m.group("amt"))))
        elif m := TOTAL_RE.match(line):
            fields["total_cents"] = parse_amount(m.group("amt"))
            fields["currency"] = (m.group("cur") or "").upper() or None
            break
        elif fields["subtotal_cents"] is None and (m := LINE_RE.match(line)):
            fields["lines"].append({
                "description": m.group("desc").strip(),
                "quantity": m.group("qty").replace(",", "."),
                "unit_price_cents": parse_amount(m.group("unit")),
                "amount_cents": parse_amount(m.group("amount")),
            })
    if fields["currency"] is None:
        fields["currency"] = "USD" if re.search(r"\bUSD\b", text) else "CAD"

    fields["document_type"] = (
        "credit_note" if CREDIT_NOTE_RE.search(text) or (fields["total_cents"] or 0) < 0 else "invoice")

    # ── where to send the money ──
    remit = REMIT_RE.search(text)
    fields["bank_institution"], fields["bank_transit"], fields["bank_account"] = (
        remit.groups() if remit else (None, None, None))

    # Language is decided per document, not per email: subjects say "Facture" over English invoices.
    fields["language"] = "fr" if re.search(r"Sous-total|Facture\s*n|Facturer\s+à|\bTPS\b|\bTVQ\b|Échéance", text) else "en"
    return fields
