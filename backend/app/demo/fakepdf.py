"""Write a one-page invoice PDF from plain text lines. Used by "Try to fool us" to forge invoices.

A PDF is a small text format: a font, a page, and a stream of drawing commands ("move here, show this
text"). Writing it by hand (about 40 lines) avoids a PDF library and keeps the fake honest: it's a normal
PDF with a text layer, read by the very same pdftotext + parser as every real invoice.

Courier is used because every character has the same width, so columns line up exactly as they would on a
real invoice and `pdftotext -layout` keeps them on one line.
"""

import uuid

PAGE_W, PAGE_H = 612, 792       # US Letter, in points (1/72 inch)
LEFT, TOP, LEADING = 42, 750, 13


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def pdf_from_lines(lines: list[str], bold_first: bool = True) -> bytes:
    """lines: the text of the page, top to bottom (max ~88 characters each at 10 pt)."""
    ops = [f"BT /F{2 if bold_first else 1} 10 Tf {LEADING} TL {LEFT} {TOP} Td"]
    for i, line in enumerate(lines):
        if i == 1 and bold_first:
            ops.append("/F1 10 Tf")
        ops.append(f"({_escape(line)}) Tj T*")
    ops.append("ET")
    stream = "\n".join(ops).encode("cp1252")   # WinAnsi: covers é, è, ° used in French invoices

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
         f"/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>").encode(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    # A unique comment makes every fake a different file (different sha256), so re-trying a trick is a new
    # attempt rather than "we already have this exact file". It isn't text on the page.
    out = bytearray(b"%PDF-1.4\n%fake " + uuid.uuid4().hex.encode() + b"\n")
    offsets = []
    for n, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)
