"""Load the Brim dataset (every CSV plus inbox/emails.json) into Postgres.

    python -m app.seed             drop everything and reload from scratch
    python -m app.seed --if-empty  only load when the database has not been seeded yet (container start)

Each table is described by a list of (csv column, db column, converter). The loader refuses to run if a CSV
has a column that is not in its list, so nothing in the dataset can be silently dropped.
"""

import argparse
import csv
import json
import re
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

from app import audit, config, db
from app.money import to_cents

SCHEMA_SQL = Path(__file__).with_name("schema.sql")


# ── converters: CSV text -> Python value. An empty cell always becomes NULL. ──

def text(v: str):
    return v if v != "" else None


def integer(v: str):
    return int(v) if v != "" else None


def decimal(v: str):
    return Decimal(v) if v != "" else None


def day(v: str):
    return date.fromisoformat(v) if v != "" else None


def timestamp(v: str):
    return datetime.fromisoformat(v) if v != "" else None


def yes_no(v: str) -> bool:
    if v not in ("yes", "no"):
        raise ValueError(f"expected yes/no, got {v!r}")
    return v == "yes"


cents = to_cents


def same(*cols, conv=text):
    """Columns whose name is unchanged in the database."""
    return [(c, c, conv) for c in cols]


def money(*cols):
    """Dollar columns stored as <name>_cents."""
    return [(c, f"{c}_cents", cents) for c in cols]


# ── table specs, in foreign-key order ──

TABLES = [
    ("departments", "departments.csv",
     same("department_id", "name", "cost_centre", "manager_user_id")
     + [("annual_budget_cad", "annual_budget_cents", cents)]),

    ("users", "users.csv",
     same("user_id", "full_name", "email", "title", "department_id", "manager_id", "role",
          "work_province", "status", "delegate_user_id")
     + same("status_since", "hire_date", conv=day)
     + [("approval_limit_cad", "approval_limit_cents", cents)]),

    ("gl_accounts", "gl_accounts.csv",
     same("account_number", "name", "account_type", "notes")),

    ("tax_codes", "tax_codes.csv",
     same("code", "description", "applies_to", "recoverable", "gl_account")
     + same("rate", conv=decimal)),

    ("fx_rates", "fx_rates.csv",
     same("date", conv=day) + same("usd_to_cad", conv=decimal)),

    ("approval_policies", "approval_policies.csv",
     same("rule_id", "rule_type", "condition", "required", "notes")),

    ("vendors", "vendors.csv",
     same("vendor_id", "legal_name", "category", "default_gl_account", "address", "province_or_state",
          "country", "gst_hst_number", "qst_number", "early_pay_discount", "preferred_payment_method",
          "bank_institution", "bank_transit", "bank_account", "ap_contact_email", "status")
     + same("payment_terms_days", conv=integer)
     + same("accepts_card_payment", "requires_po", conv=yes_no)
     + same("bank_details_updated_at", "onboarded_at", conv=day)),

    ("bank_change_history", "bank_change_history.csv",
     same("change_id", "vendor_id", "changed_by_user_id", "request_channel", "old_account_last4",
          "new_account_last4")
     + same("changed_at", conv=day)
     + same("verified_by_callback", conv=yes_no)),

    ("contracts", "contracts.csv",
     same("contract_id", "vendor_id", "description", "billing_type", "currency", "status")
     + money("monthly_fee", "hourly_rate_cap", "not_to_exceed_monthly")
     + same("fuel_surcharge_cap_pct", conv=decimal)
     + same("start_date", "end_date", conv=day)
     + same("auto_renew", conv=yes_no)),

    ("purchase_orders", "purchase_orders.csv",
     same("po_id", "vendor_id", "department_id", "requester_user_id", "description", "currency", "status",
          "approved_by")
     + same("issue_date", conv=day)
     + money("total_amount")),

    ("invoices", "invoices.csv",
     same("invoice_id", "vendor_id", "vendor_invoice_number", "currency", "department_id",
          "requester_user_id", "po_id", "contract_id", "ship_to_province", "status")
     + same("invoice_date", "received_date", "due_date", conv=day)
     + money("subtotal", "total", "total_cad")
     + [("gst_hst_amount", "gst_hst_cents", cents), ("pst_qst_amount", "pst_qst_cents", cents)]
     + same("fx_rate_to_cad", conv=decimal)),

    ("invoice_lines", "invoice_lines.csv",
     same("invoice_id", "description", "gl_account", "department_id", "gst_hst_code", "pst_qst_code",
          "line_type")
     + same("line_no", conv=integer)
     + same("quantity", conv=decimal)
     + money("unit_price", "amount")),

    ("approvals", "approvals.csv",
     same("approval_id", "invoice_id", "approver_user_id", "approver_role", "action", "comment")
     + same("step_no", conv=integer)
     + same("acted_at", conv=timestamp)),

    ("payments", "payments.csv",
     same("payment_id", "invoice_id", "vendor_id", "method", "currency", "reference", "status",
          "prepared_by", "released_by")
     + same("scheduled_date", "paid_date", conv=day)
     + same("fx_rate_to_cad", conv=decimal)
     + money("amount", "amount_cad", "discount_taken")),

    ("bank_statement", "bank_statement.csv",
     same("bank_txn_id", "description")
     + same("posted_date", conv=day)
     + money("debit", "credit")),

    ("card_transactions", "card_transactions.csv",
     same("txn_id", "card_id", "cardholder_user_id", "merchant_descriptor", "mcc", "currency", "source", "memo")
     + same("posted_date", conv=day)
     + same("receipt_attached", conv=yes_no)
     + money("amount", "amount_cad")),
]


def load_csv(conn, table: str, filename: str, spec) -> int:
    path = config.DATA_DIR / "data" / filename
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        missing = set(reader.fieldnames) - {csv_col for csv_col, _, _ in spec}
        if missing:
            raise RuntimeError(f"{filename}: columns not mapped in seed.py: {sorted(missing)}")
        rows = [[conv(row[csv_col]) for csv_col, _, conv in spec] for row in reader]

    columns = ", ".join(db_col for _, db_col, _ in spec)
    placeholders = ", ".join(["%s"] * len(spec))
    with conn.cursor() as cur:
        cur.executemany(f"INSERT INTO {table} ({columns}) VALUES ({placeholders})", rows)
    return len(rows)


def load_emails(conn) -> int:
    emails = json.loads((config.DATA_DIR / "inbox" / "emails.json").read_text(encoding="utf-8"))
    with conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO emails (email_id, from_name, from_address, to_address, subject, received_at, body,
                                   attachments)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
            [(e["email_id"], e["from_name"], e["from_address"], e["to_address"], e["subject"],
              datetime.fromisoformat(e["received_at"]), e["body"], e["attachments"]) for e in emails],
        )
    return len(emails)


def parse_policy_thresholds(conn) -> None:
    """'Invoice total over $10,000 CAD' -> threshold_cents = 1000000. Policies without an amount stay NULL."""
    for policy in conn.execute("SELECT rule_id, condition FROM approval_policies").fetchall():
        match = re.search(r"\$([\d,]+(?:\.\d{2})?)", policy["condition"])
        if match:
            conn.execute("UPDATE approval_policies SET threshold_cents = %s WHERE rule_id = %s",
                         (to_cents(match.group(1)), policy["rule_id"]))


def advance_sequences(conn) -> None:
    """Make new IDs continue after the dataset's highest ones (AP-00427, PAY-00416, AP-A-00475...)."""
    for seq, table, column in [("invoice_number_seq", "invoices", "invoice_id"),
                               ("payment_number_seq", "payments", "payment_id"),
                               ("approval_number_seq", "approvals", "approval_id")]:
        conn.execute(
            f"SELECT setval('{seq}', (SELECT max(substring({column} from '(\\d+)$')::int) FROM {table}))")


def is_seeded(conn) -> bool:
    exists = conn.execute("SELECT to_regclass('public.audit_events') IS NOT NULL AS ok").fetchone()["ok"]
    if not exists:
        return False
    return conn.execute("SELECT count(*) AS n FROM audit_events WHERE action = 'system.seed'").fetchone()["n"] > 0


def seed(url: str | None = None) -> dict[str, int]:
    counts: dict[str, int] = {}
    with db.transaction(url) as conn:
        conn.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        conn.execute(SCHEMA_SQL.read_text(encoding="utf-8"))
        for table, filename, spec in TABLES:
            counts[table] = load_csv(conn, table, filename, spec)
        counts["emails"] = load_emails(conn)
        parse_policy_thresholds(conn)
        advance_sequences(conn)
        # The first link of the signed audit chain (audit_chain.py).
        audit.log(conn, actor=None, action="system.seed", entity_type="database", entity_id="all",
                  after=counts, reason="Initial load of the Brim AP dataset")
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--if-empty", action="store_true", help="skip if the database is already seeded")
    args = parser.parse_args()

    if args.if_empty:
        with db.connect() as conn:
            if is_seeded(conn):
                print("Database already seeded, skipping. Run `make reseed` to reload.")
                return

    counts = seed()
    width = max(len(t) for t in counts)
    for table, n in counts.items():
        print(f"  {table:<{width}}  {n:>4} rows")
    print(f"Seeded {sum(counts.values())} rows into {len(counts)} tables.")


if __name__ == "__main__":
    main()
