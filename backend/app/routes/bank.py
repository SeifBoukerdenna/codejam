"""Bank statement check: every line matched or explained (reconcile.py), and the three ways to close one."""

from fastapi import APIRouter, Depends, HTTPException

from app import audit, breakdowns, reconcile
from app.auth import can, current_user, require
from app.db import get_conn

router = APIRouter(prefix="/api")


def _bank_fee_account(conn) -> str:
    # Looked up by name rather than hard-coded, so another chart of accounts works too.
    row = conn.execute("""SELECT account_number FROM gl_accounts WHERE name ILIKE '%bank%' AND account_type = 'expense'
                          ORDER BY account_number LIMIT 1""").fetchone()
    if not row:
        raise HTTPException(409, "There's no bank fees account in the chart of accounts.")
    return row["account_number"]


@router.get("/bank")
def bank_page(conn=Depends(get_conn), user=Depends(current_user)):
    result = reconcile.check_statement(conn)
    signer = user["full_name"] if user else "Accounts Payable"
    # Count + amount per kind of open work, so the page shows them without adding anything up itself.
    todo_totals = {todo: {"count": sum(1 for l in result["lines"] if l["todo"] == todo),
                          "cents": sum(l["at_stake_cents"] if todo == "ask_bank" else l["amount_cents"]
                                       for l in result["lines"] if l["todo"] == todo)}
                   for todo in ("ask_bank", "book_fee", "mark_cashed")}
    return {**result, "letter": reconcile.letter_to_bank(result, signer), "bank_fee_account": _bank_fee_account(conn),
            "todo_totals": todo_totals, "in_question_cents": result["unexplained_cents"] + result["waiting_cents"],
            "in_question_breakdown": breakdowns.bank_in_question(result),
            "can_act": can(conn, user, "bank.reconcile").as_dict()}


def _close(conn, user, todo: str, resolution: str, action: str, reason, gl: str | None = None) -> int:
    """Record a decision for every open line of one kind, each with its own audit event."""
    require(conn, user, "bank.reconcile")
    lines = [l for l in reconcile.check_statement(conn)["lines"] if l["todo"] == todo]
    if not lines:
        raise HTTPException(409, "Nothing left to do here.")
    for line in lines:
        conn.execute("""INSERT INTO statement_reviews (bank_txn_id, resolution, gl_account, resolved_by)
                        VALUES (%s, %s, %s, %s)""", (line["bank_txn_id"], resolution, gl, user["user_id"]))
        audit.log(conn, actor=user["user_id"], action=action, entity_type="bank_line", entity_id=line["bank_txn_id"],
                  after={"resolution": resolution, "gl_account": gl, "amount_cents": line["amount_cents"]}, reason=reason(line))
    return len(lines)


@router.post("/bank/ask")
def asked_the_bank(conn=Depends(get_conn), user=Depends(current_user)):
    """The letter was sent (from the clerk's own mailbox): these lines now wait for the bank's answer."""
    with conn.transaction():
        n = _close(conn, user, "ask_bank", "asked_bank", "bank.asked",
                   lambda l: f"Asked the bank about {l['description']}: {l['explanation']}")
    return {"asked": n}


@router.post("/bank/book-fees")
def book_fees(conn=Depends(get_conn), user=Depends(current_user)):
    with conn.transaction():
        gl = _bank_fee_account(conn)
        n = _close(conn, user, "book_fee", "fee_booked", "bank.fee_booked",
                   lambda l: f"{l['description']} booked to {gl}", gl)
    return {"booked": n}


@router.post("/bank/cheques-cashed")
def cheques_cashed(conn=Depends(get_conn), user=Depends(current_user)):
    """The bank shows these cheques cleared: the payments are settled, not 'outstanding' any more."""
    with conn.transaction():
        cashed = [l for l in reconcile.check_statement(conn)["lines"] if l["todo"] == "mark_cashed"]
        n = _close(conn, user, "mark_cashed", "cheque_cashed", "bank.cheque_cashed",
                   lambda l: f"{l['payment_id']} to {l['vendor_name']} cleared on {l['posted_date']}")
        for line in cashed:
            conn.execute("UPDATE payments SET status = 'settled' WHERE payment_id = %s AND status = 'outstanding'",
                         (line["payment_id"],))
            audit.log(conn, actor=user["user_id"], action="payment.settle", entity_type="payment",
                      entity_id=line["payment_id"], before={"status": "outstanding"}, after={"status": "settled"},
                      reason=f"Cheque cleared on the bank statement ({line['bank_txn_id']}, {line['posted_date']})")
    return {"cashed": n}
