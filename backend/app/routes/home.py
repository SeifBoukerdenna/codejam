"""Home page: what needs the current user, money paid out this year, and what's going out next."""

from datetime import date

from fastapi import APIRouter, Depends

from app import config
from app.auth import current_user
from app.db import get_conn
from app.routes.payments import PAYMENT_ROWS_SQL

router = APIRouter(prefix="/api")


def _count(conn, sql: str, params=()) -> int:
    return conn.execute(sql, params).fetchone()["n"]


@router.get("/home")
def home(conn=Depends(get_conn), user=Depends(current_user)):
    today = config.TODAY
    year_start = date(today.year, 1, 1)

    # Money out per month, Jan through the current month. Months with no payments still get a zero bar so
    # the chart never silently skips a month.
    by_month = {
        r["month"]: r
        for r in conn.execute(
            """SELECT to_char(paid_date, 'YYYY-MM') AS month, count(*) AS count,
                      sum(amount_cad_cents)::bigint AS total_cad_cents
               FROM payments
               WHERE paid_date BETWEEN %s AND %s
               GROUP BY 1""",
            (year_start, today),
        ).fetchall()
    }
    months = [f"{today.year}-{m:02d}" for m in range(1, today.month + 1)]
    paid_by_month = [
        {"month": m, "count": by_month.get(m, {}).get("count", 0),
         "total_cad_cents": by_month.get(m, {}).get("total_cad_cents", 0)}
        for m in months
    ]

    # Daily totals for the cumulative "paid this year" line chart (the UI fills in days with nothing paid).
    paid_daily = conn.execute(
        """SELECT paid_date AS date, sum(amount_cad_cents)::bigint AS total_cad_cents, count(*) AS count
           FROM payments WHERE paid_date BETWEEN %s AND %s GROUP BY paid_date ORDER BY paid_date""",
        (year_start, today),
    ).fetchall()

    user_id = user["user_id"] if user else None
    todo = {
        "emails_to_sort": _count(conn, "SELECT count(*) AS n FROM emails WHERE intake_status = 'unprocessed'"),
        "replies_to_send": _count(conn, "SELECT count(*) AS n FROM emails WHERE intake_status = 'processed' "
                                        "AND reply_draft IS NOT NULL"),
        "needs_review": _count(conn, "SELECT count(*) AS n FROM invoices WHERE status = 'needs_review'"),
        "on_hold": _count(conn, "SELECT count(*) AS n FROM invoices WHERE status = 'on_hold'"),
        "waiting_for_me": _count(
            conn, "SELECT count(*) AS n FROM approvals WHERE action = 'pending' AND approver_user_id = %s",
            (user_id,)),
        "payments_to_release": _count(conn, "SELECT count(*) AS n FROM payments WHERE status = 'prepared'"),
        "approved_to_pay": _count(conn, "SELECT count(*) AS n FROM invoices WHERE status = 'approved' AND NOT is_credit_note"),
        "payments_held": _count(conn, "SELECT count(*) AS n FROM payments WHERE status = 'held'"),
    }

    # "Going out next" = everything queued to leave: prepared (waiting for release), released and scheduled.
    scheduled = conn.execute(
        """SELECT count(*) AS count, coalesce(sum(amount_cad_cents), 0)::bigint AS total_cad_cents
           FROM payments WHERE status IN ('prepared', 'released', 'scheduled')"""
    ).fetchone()
    upcoming = conn.execute(
        f"{PAYMENT_ROWS_SQL} WHERE p.status IN ('prepared', 'released', 'scheduled') "
        f"ORDER BY p.scheduled_date, p.payment_id LIMIT 5"
    ).fetchall()

    return {
        "today": today.isoformat(),
        "paid_this_year_cad_cents": sum(m["total_cad_cents"] for m in paid_by_month),
        "payments_this_year": sum(m["count"] for m in paid_by_month),
        "paid_by_month": paid_by_month,
        "paid_daily": paid_daily,
        "todo": todo,
        "scheduled": scheduled,
        "upcoming": upcoming,
    }
