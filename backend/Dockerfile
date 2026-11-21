FROM python:3.12-slim

# OCR toolchain for the extraction worker:
#   poppler-utils  pdftotext (reads a PDF's text layer) and pdftoppm (renders a page to an image for OCR)
#   tesseract-ocr  open-source OCR engine, with English and French language data
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-fra \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PYTHONUNBUFFERED=1
