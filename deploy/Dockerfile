# One container for Render: the API and the OCR worker together, with the dataset baked in.
# DECISION: one container instead of two services because Render's free tier has no background workers; the
# worker still talks to the API only through Postgres, so splitting them later is a config change, not a code one.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-fra \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ .
COPY data/ /data/
COPY deploy/start.sh /start.sh

ENV PYTHONUNBUFFERED=1 DATA_DIR=/data/brim_ap_dataset AP_TODAY=2026-11-02
CMD ["sh", "/start.sh"]
