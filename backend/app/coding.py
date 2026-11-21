"""Smart coding: suggest the GL account and department for each invoice line, with the reason in words.

"Learned" from history by counting, not by a model:
  1. this vendor's past lines: all one account -> use it; otherwise the most similar past description;
     otherwise the most common account
  2. no history: the vendor's default GL account from the vendor master
  3. unknown vendor: the most similar past line from ANY vendor
Only lines from invoices that went through (approved/scheduled/paid) teach us anything. A rejected invoice,
e.g. AP-00037 "Coding incorrect, resubmit", must not.
Similarity = shared words / all words (Jaccard), a measure anyone can recompute by hand.
"""

import re
from collections import Counter

WORD_RE = re.compile(r"[a-zà-ÿ]{3,}")
STOP = {"the", "and", "for", "des", "les", "pour", "with", "from"}
SIMILAR_ENOUGH = 0.34


def words(text: str) -> set[str]:
    return set(WORD_RE.findall(text.lower())) - STOP


def similarity(a: str, b: str) -> float:
    wa, wb = words(a), words(b)
    return len(wa & wb) / len(wa | wb) if wa and wb else 0.0


def _learned_lines(conn) -> list[dict]:
    return conn.execute(
        """SELECT l.description, l.gl_account, l.department_id, l.line_type, i.invoice_id, i.vendor_id,
                  i.requester_user_id, v.legal_name AS vendor_name
           FROM invoice_lines l JOIN invoices i USING (invoice_id) LEFT JOIN vendors v ON v.vendor_id = i.vendor_id
           WHERE i.status IN ('approved', 'scheduled', 'paid') AND l.gl_account IS NOT NULL"""
    ).fetchall()


def _most_common(counter: Counter) -> tuple[str, int, int]:
    value, count = counter.most_common(1)[0]
    return value, count, sum(counter.values())


def suggest(conn, vendor: dict | None, lines: list[dict], po: dict | None) -> dict:
    gl_names = {g["account_number"]: g["name"] for g in conn.execute("SELECT * FROM gl_accounts")}
    dept_names = {d["department_id"]: d["name"] for d in conn.execute("SELECT * FROM departments")}
    learned = _learned_lines(conn)
    own = [h for h in learned if vendor and h["vendor_id"] == vendor["vendor_id"]]

    coded_lines = []
    for line in lines:
        desc = line["description"]
        gl, reason, line_type = None, "No suggestion yet. Choose an account.", None
        if own:
            gl_counts = Counter(h["gl_account"] for h in own)
            best = max(own, key=lambda h: similarity(desc, h["description"]))
            if len(gl_counts) == 1:
                gl, n = next(iter(gl_counts)), len(own)
                reason = f"All {n} past lines from this vendor went to {gl} {gl_names[gl]}"
            elif similarity(desc, best["description"]) >= SIMILAR_ENOUGH:
                gl = best["gl_account"]
                reason = f"Most like past line “{best['description']}” ({best['invoice_id']}), coded {gl} {gl_names[gl]}"
            else:
                gl, k, n = _most_common(gl_counts)
                reason = f"{k} of {n} past lines from this vendor went to {gl} {gl_names[gl]}"
            line_type = _most_common(Counter(h["line_type"] for h in own))[0]
        elif vendor and vendor["default_gl_account"]:
            gl = vendor["default_gl_account"]
            reason = f"No history yet; {gl} {gl_names[gl]} is this vendor's default account"
        elif learned:
            best = max(learned, key=lambda h: similarity(desc, h["description"]))
            if similarity(desc, best["description"]) >= SIMILAR_ENOUGH:
                gl, line_type = best["gl_account"], best["line_type"]
                reason = (f"Unknown vendor; most like “{best['description']}” from {best['vendor_name']}, "
                          f"coded {gl} {gl_names[gl]}")
        coded_lines.append({"gl_account": gl, "coding_reason": reason, "line_type": line_type or "services"})

    if po:
        department, dept_reason = po["department_id"], f"Taken from purchase order {po['po_id']}"
    elif own:
        department, k, n = _most_common(Counter(h["department_id"] for h in own))
        dept_reason = (f"All {n} past lines from this vendor were charged to {dept_names[department]}" if k == n
                       else f"{k} of {n} past lines from this vendor were charged to {dept_names[department]}")
    else:
        department, dept_reason = None, "No history for this vendor. Choose a department."

    # DECISION: incoming invoices don't name a requester. Use the PO's requester, else whoever most often
    # requested this vendor's invoices before. The AP clerk can change it before submitting.
    if po:
        requester, req_reason = po["requester_user_id"], f"Requested purchase order {po['po_id']}"
    elif own:
        active = {u["user_id"] for u in conn.execute("SELECT user_id FROM users WHERE status = 'active'")}
        per_invoice = {h["invoice_id"]: h["requester_user_id"] for h in own if h["requester_user_id"] in active}
        if per_invoice:
            requester, k, n = _most_common(Counter(per_invoice.values()))
            req_reason = f"Requested {k} of {n} past invoices from this vendor (people still here)"
        else:
            requester, req_reason = None, "Past requesters for this vendor have left. Choose who requested it."
    else:
        requester, req_reason = None, "No history for this vendor. Choose who requested it."

    return {"lines": coded_lines, "department_id": department, "department_reason": dept_reason,
            "requester_user_id": requester, "requester_reason": req_reason}
