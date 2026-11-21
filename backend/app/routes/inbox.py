"""The AP inbox: emails as received, sorting them, uploads, and what's waiting to be read."""

import mimetypes

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app import config, intake
from app.auth import current_user, require
from app.db import get_conn

router = APIRouter(prefix="/api")

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
ACCEPTED_TYPES = {"application/pdf", "image/png", "image/jpeg", "image/tiff"}


@router.get("/emails")
def list_emails(conn=Depends(get_conn)):
    return conn.execute(
        """SELECT e.email_id, e.from_name, e.from_address, e.subject, e.received_at, e.attachments, e.classification,
                  e.intake_status, e.intake_note,
                  coalesce((SELECT json_agg(json_build_object('invoice_id', i.invoice_id, 'status', i.status,
                                                              'number', i.vendor_invoice_number) ORDER BY i.invoice_id)
                            FROM invoices i WHERE i.email_id = e.email_id), '[]') AS invoices
           FROM emails e ORDER BY e.received_at DESC, e.email_id DESC"""
    ).fetchall()


@router.get("/emails/{email_id}")
def get_email(email_id: str, conn=Depends(get_conn)):
    email = conn.execute("SELECT * FROM emails WHERE email_id = %s", (email_id,)).fetchone()
    if not email:
        raise HTTPException(404, "Email not found")
    return email


@router.get("/emails/{email_id}/attachments/{filename}")
def get_attachment(email_id: str, filename: str, conn=Depends(get_conn)):
    email = conn.execute("SELECT attachments FROM emails WHERE email_id = %s", (email_id,)).fetchone()
    # Only names listed on the email are served. That check is also what stops '../' path tricks, since
    # no attachment name in the inbox contains a slash.
    if not email or filename not in email["attachments"]:
        raise HTTPException(404, "Attachment not found on this email")
    path = config.DATA_DIR / "incoming_invoices" / filename
    if not path.is_file():
        raise HTTPException(404, "Attachment file is missing")
    media_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type, content_disposition_type="inline", filename=filename)


@router.post("/inbox/process")
def process_inbox(conn=Depends(get_conn), user=Depends(current_user)):
    with conn.transaction():
        require(conn, user, "inbox.process")
        counts = intake.process_inbox(conn, user["user_id"])
    return counts


@router.post("/documents", status_code=201)
async def upload(file: UploadFile = File(...), conn=Depends(get_conn), user=Depends(current_user)):
    content = await file.read()
    mime = file.content_type or mimetypes.guess_type(file.filename or "")[0]
    if mime not in ACCEPTED_TYPES:
        raise HTTPException(415, "Upload a PDF or an image (PNG, JPEG, TIFF).")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "That file is over 10 MB.")
    with conn.transaction():
        require(conn, user, "document.upload")
        document_id, new = intake.store_document(conn, filename=file.filename or "upload", content=content,
                                                 source="upload", uploaded_by=user["user_id"])
    if not new:
        existing = conn.execute("SELECT invoice_id FROM invoices WHERE document_id = %s", (document_id,)).fetchone()
        raise HTTPException(409, "We already have this exact file" +
                            (f": it's invoice {existing['invoice_id']}." if existing else ", it's being read."))
    return {"document_id": document_id}


@router.get("/inbox/queue")
def reading_queue(conn=Depends(get_conn)):
    """Documents waiting for, or in, the extraction worker."""
    rows = conn.execute("SELECT status, count(*) AS n FROM extraction_jobs GROUP BY status").fetchall()
    failed = conn.execute(
        """SELECT j.job_id, d.filename, j.error FROM extraction_jobs j JOIN documents d USING (document_id)
           WHERE j.status = 'failed' ORDER BY j.job_id""").fetchall()
    return {"counts": {r["status"]: r["n"] for r in rows}, "failed": failed}
