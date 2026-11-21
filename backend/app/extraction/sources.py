"""Where on the page each extracted field was read: boxes for highlighting, as fractions of the page (0–1).

This runs AFTER the parser and never changes what it read. It takes the words with their positions
(`pdftotext -bbox` for PDFs with a text layer, Tesseract's TSV output for scans), groups them into visual rows
the way a person reads the page, and looks for each parsed value:
  * amounts: a run of 1–3 words that IS an amount (same AMOUNT pattern as the parser) worth exactly that many cents,
    on a row with the right label (Total vs Subtotal vs a tax line);
  * dates, invoice numbers, GST/QST numbers, bank numbers: the exact characters, on a row with their label;
  * the vendor name: the exact words, first time they appear.
DECISION: a value we can't find gets NO box. A missing highlight is honest; a box drawn around the wrong number
would teach the reviewer to trust the wrong thing. Rejected: fuzzy matching and "nearest number" guesses.
"""

import html
import re
import subprocess
import tempfile
from pathlib import Path

from app.extraction.parser import AMOUNT, parse_amount
from app.extraction.text import OCR_LANGUAGES, OCR_PAGE_MODES

AMOUNT_FULL = re.compile(rf"^{AMOUNT}$")
WORD_RE = re.compile(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>')
PAGE_RE = re.compile(r'<page width="([\d.]+)" height="([\d.]+)">')

# Row labels, English and French, as printed on the dataset's invoices.
SUBTOTAL_ROW = re.compile(r"sub-?\s?total|sous-total", re.I)
TOTAL_ROW = re.compile(r"\btotal\b", re.I)
TAX_ROW = re.compile(r"\b(GST|HST|PST|QST|TPS|TVH|TVQ|tax|taxe)\b|%", re.I)
NUMBER_ROW = re.compile(r"invoice|facture|\binv\b|n[°o]|#", re.I)
DUE_ROW = re.compile(r"\bdue\b|[ée]ch[ée]ance", re.I)
DATE_ROW = re.compile(r"\bdate\b|issued", re.I)
TAX_ID_ROW = re.compile(r"GST|HST|TPS|TVH|QST|TVQ", re.I)
BANK_ROW = re.compile(r"inst|transit|acc(?:oun)?t|compte|banque|bank|eft|virement", re.I)


# ── words and rows ──

def pdf_words(pdf: Path) -> list[dict]:
    """Words of page 1 with their box, from the PDF's own text layer (exact positions)."""
    out = subprocess.run(["pdftotext", "-bbox", "-f", "1", "-l", "1", str(pdf), "-"],
                         check=True, capture_output=True, text=True, timeout=60).stdout
    page = PAGE_RE.search(out)
    width, height = float(page.group(1)), float(page.group(2))
    return [{"text": html.unescape(t), "x0": float(a) / width, "y0": float(b) / height,
             "x1": float(c) / width, "y1": float(d) / height} for a, b, c, d, t in WORD_RE.findall(out)]


def ocr_words(image: Path, mode: int) -> list[dict]:
    """Words of a scan with their box, from one Tesseract pass (same page mode as the reading we kept)."""
    out = subprocess.run(["tesseract", str(image), "stdout", "-l", OCR_LANGUAGES, "--psm", str(mode), "tsv"],
                         check=True, capture_output=True, text=True, timeout=120).stdout
    rows = [line.split("\t") for line in out.splitlines()[1:]]
    page = next(r for r in rows if r[0] == "1")
    width, height = float(page[8]), float(page[9])
    words = []
    for r in rows:
        if r[0] == "5" and len(r) == 12 and r[11].strip():
            left, top, w, h = (float(v) for v in r[6:10])
            words.append({"text": r[11].strip(), "x0": left / width, "y0": top / height,
                          "x1": (left + w) / width, "y1": (top + h) / height})
    return words


def rows_of(words: list[dict]) -> list[dict]:
    """Group words into visual rows: same height on the page, read left to right."""
    rows: list[list[dict]] = []
    for word in sorted(words, key=lambda w: ((w["y0"] + w["y1"]) / 2, w["x0"])):
        middle = (word["y0"] + word["y1"]) / 2
        if rows and abs(middle - rows[-1][0]["_mid"]) < 0.5 * (word["y1"] - word["y0"]):
            rows[-1].append({**word, "_mid": middle})
        else:
            rows.append([{**word, "_mid": middle}])
    return [{"words": sorted(r, key=lambda w: w["x0"]), "text": " ".join(w["text"] for w in sorted(r, key=lambda w: w["x0"]))}
            for r in rows]


def _box(words: list[dict]) -> dict:
    return {"x0": round(min(w["x0"] for w in words), 4), "y0": round(min(w["y0"] for w in words), 4),
            "x1": round(max(w["x1"] for w in words), 4), "y1": round(max(w["y1"] for w in words), 4)}


def _windows(row: dict, longest: int):
    words = row["words"]
    for n in range(1, longest + 1):
        for i in range(len(words) - n + 1):
            yield words[i:i + n]


def _strip(text: str) -> str:
    return text.strip(" :;,.#()[]").upper()


# ── finders: each returns the words of one match, or None ──

def find_amount(rows, cents, row_ok, bottom_up=False):
    for row in (reversed(rows) if bottom_up else rows):
        if not row_ok(row["text"]):
            continue
        for window in _windows(row, 3):
            text = " ".join(w["text"] for w in window)
            if AMOUNT_FULL.match(text) and parse_amount(text) == cents:
                return window
    return None


def find_token(rows, value, row_ok=lambda t: True, longest=2):
    """Exact characters (spaces and edge punctuation ignored), e.g. '503486760 RT0001' = '503486760RT0001'."""
    want = re.sub(r"\s", "", str(value)).upper()
    for row in rows:
        if not row_ok(row["text"]):
            continue
        for window in _windows(row, longest):
            if _strip("".join(w["text"] for w in window)) == want:
                return window
    return None


def find_words(rows, phrase):
    want = phrase.upper().split()
    for row in rows:
        for window in _windows(row, len(want)):
            if [_strip(w["text"]) for w in window] == [_strip(w) for w in want]:
                return window
    return None


def locate(rows: list[dict], fields: dict) -> dict[str, list[dict]]:
    """field name -> the words it was read from. Fields: the scalar names, 'subtotal_cents', 'total_cents',
    'tax:<CODE>' per tax line and 'line:<n>' (1-based) per line item."""
    found: dict[str, list[dict]] = {}

    def put(name, words):
        if words:
            found[name] = words

    if fields.get("vendor_name"):
        put("vendor_name", find_words(rows, fields["vendor_name"]))
    if fields.get("invoice_number"):
        put("invoice_number", find_token(rows, fields["invoice_number"], lambda t: bool(NUMBER_ROW.search(t))))
    if fields.get("invoice_date"):
        put("invoice_date", find_token(rows, fields["invoice_date"],
                                       lambda t: bool(DATE_ROW.search(t)) and not DUE_ROW.search(t), longest=1))
    if fields.get("due_date"):
        put("due_date", find_token(rows, fields["due_date"], lambda t: bool(DUE_ROW.search(t)), longest=1))
    for name in ("vendor_gst", "vendor_qst"):
        if fields.get(name):
            put(name, find_token(rows, fields[name], lambda t: bool(TAX_ID_ROW.search(t)), longest=3))
    for name in ("bank_institution", "bank_transit", "bank_account"):
        if fields.get(name):
            put(name, find_token(rows, fields[name], lambda t: bool(BANK_ROW.search(t)), longest=1))

    if fields.get("subtotal_cents") is not None:
        put("subtotal_cents", find_amount(rows, fields["subtotal_cents"], lambda t: bool(SUBTOTAL_ROW.search(t))))
    if fields.get("total_cents") is not None:
        # The grand total is the LAST "Total" row that isn't the subtotal (some layouts repeat it in a header box).
        put("total_cents", find_amount(rows, fields["total_cents"],
                                       lambda t: bool(TOTAL_ROW.search(t)) and not SUBTOTAL_ROW.search(t), bottom_up=True))
    for tax in fields.get("taxes") or []:
        put(f"tax:{tax['code'] or tax['label']}", find_amount(rows, tax["amount_cents"], lambda t: bool(TAX_ROW.search(t))))

    # Line items: in order, above the subtotal row, each on its own row.
    subtotal_y = found["subtotal_cents"][0]["y0"] if "subtotal_cents" in found else 1.0
    item_rows = [r for r in rows if r["words"][0]["y1"] <= subtotal_y]
    start = 0
    for n, line in enumerate(fields.get("lines") or [], start=1):
        for i in range(start, len(item_rows)):
            # The line's amount is the LAST amount on its row (after quantity and unit price).
            row = item_rows[i]
            match = None
            for window in _windows(row, 3):
                text = " ".join(w["text"] for w in window)
                if AMOUNT_FULL.match(text) and parse_amount(text) == line["amount_cents"]:
                    match = window
            if match:
                put(f"line:{n}", match)
                start = i + 1
                break
    return found


# ── entry point used by extract.py ──

def field_sources(content: bytes, mime_type: str, engine: str, parses: list[dict], fields: dict) -> list[dict]:
    """[{field, page, x0, y0, x1, y1, source, ocr_readings?}] for every field we could find on page 1."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        if engine == "text_layer":
            pdf = tmp_dir / "doc.pdf"
            pdf.write_bytes(content)
            found = locate(rows_of(pdf_words(pdf)), fields)
            return [{"field": f, "page": 1, **_box(words), "source": "text_layer"} for f, words in found.items()]

        if mime_type == "application/pdf":     # an image-only PDF: the same 300 dpi render the OCR read
            pdf = tmp_dir / "doc.pdf"
            pdf.write_bytes(content)
            subprocess.run(["pdftoppm", "-r", "300", "-png", "-f", "1", "-l", "1", str(pdf), str(tmp_dir / "page")],
                           check=True, capture_output=True, timeout=60)
            image = next(tmp_dir.glob("page*.png"))
        else:
            image = tmp_dir / "doc.img"
            image.write_bytes(content)

        # Each field is located in the OCR pass whose reading we kept (amounts come as one block from one pass).
        def winning_pass(field):
            if field in ("subtotal_cents", "total_cents") or field.startswith(("tax:", "line:")):
                return next((i for i, p in enumerate(parses)
                             if p["total_cents"] == fields["total_cents"] and p["lines"] == fields["lines"]), 0)
            return next((i for i, p in enumerate(parses) if p.get(field) == fields.get(field)), 0)

        results = []
        located_by_pass: dict[int, dict] = {}
        wanted = [f for f in ("vendor_name", "invoice_number", "invoice_date", "due_date", "vendor_gst", "vendor_qst",
                              "bank_institution", "bank_transit", "bank_account", "subtotal_cents", "total_cents")
                  if fields.get(f) is not None]
        wanted += [f"tax:{t['code'] or t['label']}" for t in fields.get("taxes") or []]
        wanted += [f"line:{n}" for n in range(1, len(fields.get("lines") or []) + 1)]
        for field in wanted:
            i = winning_pass(field)
            if i not in located_by_pass:
                located_by_pass[i] = locate(rows_of(ocr_words(image, OCR_PAGE_MODES[i])), fields)
            words = located_by_pass[i].get(field)
            if not words:
                continue
            entry = {"field": field, "page": 1, **_box(words), "source": "ocr"}
            readings = [p.get(field) for p in parses] if field in fields and not field.endswith("_cents") else []
            if len(set(map(str, readings))) > 1:
                entry["ocr_readings"] = readings
            results.append(entry)
        return results
