"""Who must approve an invoice, in what order, and why (policies P01–P08).

1. Amount decides the chain (thresholds read from approval_policies, so they're configurable):
     up to $10k: department manager (P01)   over $10k: + finance manager (P02)
     over $50k: + controller (P03)          over $250k: + CFO (P04)
2. Extra finance manager step, whatever the amount (only one FM step in total): vendor not approved yet (P05),
   Legal vendor (P06), over the PO balance (P12), possible split invoice (P02).
3. Each step is then given to a person:
     on leave            -> their delegate, recorded as "on behalf of" (P08)
     delegate would also fill another step (or is the requester)
                         -> escalate to the absent approver's own manager instead (DECISION, see CLAUDE.md)
     approver is the requester -> their manager (P07, no self-approval)
     already approved an earlier step -> their manager (one person, one step)
Every step keeps a routing note in plain words, shown on the invoice page.
"""

ROLE_WORDS = {"dept_manager": "Department manager", "finance_manager": "Finance manager",
              "controller_admin": "Controller", "cfo": "CFO"}
MAX_ESCALATIONS = 5


def _role_holders(conn, department_id: str | None) -> dict:
    users = {u["user_id"]: u for u in conn.execute("SELECT * FROM users")}
    dept = conn.execute("SELECT manager_user_id FROM departments WHERE department_id = %s", (department_id,)).fetchone()
    admins = [u for u in users.values() if u["role"] == "controller_admin" and u["status"] != "terminated"]
    return users, {
        "dept_manager": dept["manager_user_id"] if dept else None,
        "finance_manager": next((u["user_id"] for u in users.values() if u["role"] == "finance_manager"), None),
        # The CFO is the controller_admin at the top (no manager); the controller reports to someone.
        "controller_admin": next((u["user_id"] for u in admins if u["manager_id"]), None),
        "cfo": next((u["user_id"] for u in admins if not u["manager_id"]), None),
    }


def plan_route(conn, invoice: dict, check_codes: set[str], vendor: dict | None) -> list[dict]:
    th = {r["rule_id"]: r["threshold_cents"] for r in conn.execute("SELECT * FROM approval_policies")}
    amount = abs(invoice["total_cad_cents"] or 0)

    chain = [["dept_manager", ["P01"]]]
    if amount > th["P02"]:
        chain.append(["finance_manager", ["P02"]])
    if amount > th["P03"]:
        chain.append(["controller_admin", ["P03"]])
    if amount > th["P04"]:
        chain.append(["cfo", ["P04"]])

    extra = []
    if "VENDOR_PENDING_REVIEW" in check_codes:
        extra.append("P05")
    if vendor and vendor["category"] == "Legal":
        extra.append("P06")
    if "PO_OVER_BALANCE" in check_codes:
        extra.append("P12")
    if "SPLIT_INVOICE" in check_codes and "P02" not in [r for _, rules in chain for r in rules]:
        extra.append("P02")
    if extra:
        fm_step = next((s for s in chain if s[0] == "finance_manager"), None)
        if fm_step:
            fm_step[1].extend(r for r in extra if r not in fm_step[1])
        else:
            chain.insert(1, ["finance_manager", extra])

    users, holders = _role_holders(conn, invoice["department_id"])
    requester = invoice["requester_user_id"]
    planned = {holders[role] for role, _ in chain}
    used: set[str] = set()
    steps = []

    for step_no, (role, rules) in enumerate(chain, start=1):
        person = users.get(holders[role])
        on_behalf, notes = None, []
        for _ in range(MAX_ESCALATIONS):
            if person is None:
                break
            name = person["full_name"]
            manager = users.get(person["manager_id"])
            if person["status"] == "on_leave" and person["delegate_user_id"] and on_behalf is None:
                delegate = users[person["delegate_user_id"]]
                clash = ("already approves another step of this invoice" if delegate["user_id"] in used or
                         (delegate["user_id"] in planned and delegate["user_id"] != holders[role])
                         else "requested this invoice" if delegate["user_id"] == requester else None)
                if clash and manager:
                    notes.append(f"{name} is on leave and their delegate {delegate['full_name']} {clash}, so this step "
                                 f"goes to {name}'s manager, {manager['full_name']} (P08 + one person per step).")
                    person = manager
                    continue
                notes.append(f"{name} is on leave since {person['status_since']:%b %-d}; "
                             f"{delegate['full_name']} approves on their behalf (P08).")
                on_behalf, person = person["user_id"], delegate
                continue
            if person["status"] != "active" and manager:
                notes.append(f"{name} is {person['status'].replace('_', ' ')}, so this goes to {manager['full_name']}.")
                person = manager
                continue
            if person["user_id"] == requester and manager:
                notes.append(f"{name} requested this invoice and can't approve their own request, so it goes to "
                             f"their manager, {manager['full_name']} (P07).")
                person, on_behalf = manager, None
                continue
            if person["user_id"] in used and manager:
                notes.append(f"{name} already approves another step, so this one goes to {manager['full_name']}.")
                person, on_behalf = manager, None
                continue
            break
        if person is None:
            raise ValueError(f"Nobody can approve the {ROLE_WORDS[role].lower()} step: department not set.")
        used.add(person["user_id"])
        steps.append({"step_no": step_no, "role": role, "approver_user_id": person["user_id"],
                      "on_behalf_of_user_id": on_behalf, "rule_ids": ",".join(rules),
                      "routing_note": " ".join(notes) or None})
    return steps
