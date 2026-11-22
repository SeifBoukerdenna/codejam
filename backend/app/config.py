"""Settings, read from environment variables so the same code runs in Docker, on a laptop, or on a remote
worker machine."""

import os
from decimal import Decimal
from datetime import date
from pathlib import Path

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://ap:ap@localhost:5432/ap")

# Folder that contains data/, inbox/ and incoming_invoices/.
DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parents[2] / "data" / "brim_ap_dataset"))

# DECISION: "today" is 2026-11-02, the dataset's as-of date, not the real clock. Invoice dates after it are
# future-dated, aging and due dates are computed from it. Override with AP_TODAY=YYYY-MM-DD.
TODAY = date.fromisoformat(os.environ.get("AP_TODAY", "2026-11-02"))

# DECISION: timestamps without a time zone (approvals.acted_at, emails.received_at) are Toronto local time, as
# in the dataset (Harborline's head office is in Toronto). The app writes new ones the same way, so a step
# approved today sorts and reads correctly next to the history. Audit timestamps are timestamptz instead,
# shown in the viewer's own time zone.
LOCAL_TZ = os.environ.get("AP_TIMEZONE", "America/Toronto")

# Secret that signs the audit chain (audit_chain.py). The default is for local development only; in production
# it comes from a key manager and never sits in the database or the repo.
AUDIT_KEY = os.environ.get("AUDIT_KEY", "harborline-dev-audit-key").encode()

# Rendered page images for the side-by-side invoice view (re-created on demand, so any folder works).
PAGE_CACHE_DIR = Path(os.environ.get("PAGE_CACHE_DIR", "/tmp/harborline-pages"))

# Card rewards earned per dollar paid by card, as a fraction ("0.01" = 1%). Default 0: the brief gives no rate, and
# Pay smarter (pay_smarter.py) never invents one. Set it to your real rate to see the rewards line.
CARD_REWARDS_RATE = Decimal(os.environ.get("CARD_REWARDS_RATE", "0"))
