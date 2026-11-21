"""The AP inbox: emails as received, and their attached files."""

import mimetypes

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from app import config
from app.db import get_conn

router = APIRouter(prefix="/api")


@router.get("/emails")
def list_emails(conn=Depends(get_conn)):
    return conn.execute(
        """SELECT email_id, from_name, from_address, subject, received_at, attachments, classification,
                  intake_status, intake_note
           FROM emails ORDER BY received_at DESC, email_id DESC"""
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
    # inline: the browser shows the PDF or image instead of downloading it
    return FileResponse(path, media_type=media_type, content_disposition_type="inline", filename=filename)
