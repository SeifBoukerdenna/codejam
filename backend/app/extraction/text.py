"""Get text out of a document: the PDF's own text layer when it has one, OCR otherwise.

Born-digital PDFs (54 of the 56 incoming files) carry their text, so reading it is exact and instant. Only
scans and image-only PDFs go through OCR, which is slower and can misread characters.
"""

import subprocess
import tempfile
from pathlib import Path

# DECISION: scans are OCR'd three times with different Tesseract page-segmentation modes (3 = automatic
# layout, 4 = single column, 6 = one block of text), and fields are then voted on (see extract.py).
# On the dataset's Cascadia scan each mode garbles a different part of the header, and on the Prairie scan
# two modes read the transit "55541" as "$5541". Voting recovers most fields, and any disagreement is
# shown to a person instead of being silently trusted.
OCR_PAGE_MODES = (3, 4, 6)
OCR_LANGUAGES = "eng+fra"
MIN_TEXT_LAYER_CHARS = 50  # below this a "PDF" is really just a picture of a page


def _run(args: list[str]) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=120).stdout


def pdf_text_layer(pdf: Path) -> str:
    # -layout keeps columns on the same line, so "Qty  Unit price  Amount" stay side by side.
    return _run(["pdftotext", "-layout", str(pdf), "-"])


def ocr_image(image: Path) -> list[str]:
    return [_run(["tesseract", str(image), "stdout", "-l", OCR_LANGUAGES, "--psm", str(mode)])
            for mode in OCR_PAGE_MODES]


def read_document(content: bytes, mime_type: str) -> tuple[str, list[str]]:
    """Return (engine, texts). engine is 'text_layer' (one exact text) or 'tesseract' (one text per OCR pass)."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        if mime_type == "application/pdf":
            pdf = tmp_dir / "doc.pdf"
            pdf.write_bytes(content)
            text = pdf_text_layer(pdf)
            if len(text.strip()) >= MIN_TEXT_LAYER_CHARS:
                return "text_layer", [text]
            # Image-only PDF: render the first page at 300 dpi and OCR it like a scan.
            _run(["pdftoppm", "-r", "300", "-png", "-f", "1", "-l", "1", str(pdf), str(tmp_dir / "page")])
            image = next(tmp_dir.glob("page*.png"))
            return "tesseract", ocr_image(image)
        if mime_type.startswith("image/"):
            image = tmp_dir / "doc.img"
            image.write_bytes(content)
            return "tesseract", ocr_image(image)
    raise ValueError(f"Can't read documents of type {mime_type}")
