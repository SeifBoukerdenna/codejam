"""Where each field was read (extraction/sources.py): boxes for the side-by-side invoice view.

Runs on the processed database, where the worker read every incoming document for real, so these are the
boxes the app actually stores. The parser's results are covered by the trap suite (still 50 / 50).
"""

import pytest

TEXT_PDFS = ["Invoice 002935.pdf", "beaumontrivieres_FA000557.pdf", "harlowsternllp_001468.pdf"]
SCAN = "scan_8049.png"   # Cascadia 1624, a photographed invoice read by OCR


def sources(conn, filename):
    row = conn.execute("""SELECT x.engine, x.fields, x.field_sources FROM extractions x JOIN documents d USING (document_id)
                          WHERE d.filename = %s ORDER BY x.extraction_id DESC LIMIT 1""", (filename,)).fetchone()
    assert row, f"{filename} was not read"
    return row, {s["field"]: s for s in row["field_sources"]}


@pytest.mark.parametrize("filename", TEXT_PDFS + [SCAN])
def test_total_number_and_bank_account_are_located(pconn, filename):
    row, boxes = sources(pconn, filename)
    for field in ("total_cents", "invoice_number", "bank_account"):
        assert field in boxes, f"{filename}: no box for {field}"
        assert boxes[field]["source"] == ("text_layer" if row["engine"] == "text_layer" else "ocr")


def test_every_box_is_inside_the_page(pconn):
    for row in pconn.execute("SELECT field_sources FROM extractions"):
        for box in row["field_sources"]:
            assert 0 <= box["x0"] < box["x1"] <= 1 and 0 <= box["y0"] < box["y1"] <= 1, box


def test_the_total_box_is_the_printed_total(pconn):
    # On Queen Street's invoice the total is printed once, bottom right, below the subtotal.
    _, boxes = sources(pconn, "Invoice 002935.pdf")
    assert boxes["total_cents"]["y0"] > boxes["subtotal_cents"]["y0"]
    assert boxes["total_cents"]["x0"] > 0.5


def test_ocr_disagreement_keeps_the_readings(pconn):
    # The Prairie scan's transit: the OCR passes read it differently, and the box carries all the readings.
    _, boxes = sources(pconn, "scan_8749.png")
    transit = boxes.get("bank_transit")
    assert transit and transit["source"] == "ocr"
    assert len(set(map(str, transit["ocr_readings"]))) > 1


def test_page_image_for_a_pdf_and_a_scan(api, pconn):
    doc_id = pconn.execute("SELECT document_id FROM documents WHERE filename = 'Invoice 002935.pdf'").fetchone()["document_id"]
    r = api("GET", f"/documents/{doc_id}/page.png", "U004")
    assert r.status_code == 200 and r.content[:8] == b"\x89PNG\r\n\x1a\n"
    assert int(r.headers["x-page-width"]) > 1000 and int(r.headers["x-page-height"]) > 1000

    scan_id = pconn.execute("SELECT document_id FROM documents WHERE filename = %s", (SCAN,)).fetchone()["document_id"]
    scan = api("GET", f"/documents/{scan_id}/page.png", "U004")
    original = pconn.execute("SELECT content FROM documents WHERE document_id = %s", (scan_id,)).fetchone()["content"]
    assert scan.content == bytes(original)       # a scan is shown exactly as received
