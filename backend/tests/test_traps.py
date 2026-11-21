"""Every trap in TRAP_MAP.md, as one named test. `make traps` runs them and prints CAUGHT / MISSED per trap.

They run on a database where the inbox has been sorted and the worker has read every incoming document,
exactly what happens in the app, with no shortcuts: OCR, extraction, coding, checks and routing all run for real.
"""

import pytest

from app import findings
from app.auth import can
from app.money import apply_rate
from app.pipeline import review_reasons
from app.routes.invoices import payment_resource
from app.vendor_match import similar_vendors
from app.workflow import approvals, payments
from app.workflow.routing import plan_route


# ── helpers ──

def invoice(conn, filename: str) -> dict:
    row = conn.execute("""SELECT i.* FROM invoices i JOIN documents d USING (document_id) WHERE d.filename = %s""",
                       (filename,)).fetchone()
    assert row, f"no invoice was created from {filename}"
    return row


def checks(conn, inv: dict) -> dict[str, dict]:
    return {c["code"]: c for c in conn.execute("SELECT * FROM check_results WHERE invoice_id = %s", (inv["invoice_id"],))}


def held_for(conn, filename: str, code: str) -> dict:
    inv = invoice(conn, filename)
    found = checks(conn, inv)
    assert code in found, f"{filename}: expected {code}, got {sorted(found)}"
    if found[code]["severity"] == "block":
        assert inv["status"] == "on_hold", f"{filename} should be on hold, is {inv['status']}"
    return found[code]


def users(conn) -> dict[str, dict]:
    return {u["user_id"]: u for u in conn.execute("SELECT * FROM users")}


def approve_all(conn, inv: dict) -> dict:
    people = users(conn)
    while (step := approvals.current_step(conn, inv["invoice_id"])) is not None:
        approver = people[step["approver_user_id"]]
        assert can(conn, approver, "invoice.approve", step).allowed
        approvals.act(conn, inv, step, approver, True, None)
    return conn.execute("SELECT * FROM invoices WHERE invoice_id = %s", (inv["invoice_id"],)).fetchone()


def email(conn, email_id: str) -> dict:
    return conn.execute("SELECT * FROM emails WHERE email_id = %s", (email_id,)).fetchone()


# ── 1. fraud and vendors ──

def cascadia_1624_scan_held_for_unverified_bank_change(c):
    held_for(c, "scan_8049.png", "BANK_CHANGE_UNVERIFIED")


def cascadia_1625_held_for_unverified_bank_change(c):
    held_for(c, "cascadiacartagel_1625.pdf", "BANK_CHANGE_UNVERIFIED")


def harlow_and_stern_lookalike_blocked(c):
    assert held_for(c, "Invoice HA26-2766.pdf", "VENDOR_LOOKALIKE")["details"]["lookalike_of"] == "V026"


def great_lakes_incorporated_flagged_as_duplicate_vendor(c):
    v = c.execute("SELECT * FROM vendors WHERE vendor_id = 'V053'").fetchone()
    found = similar_vendors(c, name=v["legal_name"], gst=v["gst_hst_number"], bank_account=v["bank_account"],
                            email=v["ap_contact_email"], exclude_id="V053")
    assert any(s["vendor_id"] == "V002" and s["kind"] == "duplicate" for s in found)


def blue_heron_not_in_vendor_master(c):
    held_for(c, "Invoice 4443.pdf", "VENDOR_NOT_IN_MASTER")


def zephyr_not_in_vendor_master(c):
    held_for(c, "zephyrdataservic_7590.pdf", "VENDOR_NOT_IN_MASTER")


def riverbend_pending_review_gets_extra_finance_step_P05(c):
    inv = invoice(c, "riverbendcaterin_1739.pdf")
    assert "VENDOR_PENDING_REVIEW" in checks(c, inv)
    vendor = c.execute("SELECT * FROM vendors WHERE vendor_id = %s", (inv["vendor_id"],)).fetchone()
    route = plan_route(c, inv, {"VENDOR_PENDING_REVIEW"}, vendor)
    assert any(s["role"] == "finance_manager" and "P05" in s["rule_ids"] for s in route)


# ── 2. duplicates (incoming) ──

def duplicate(c, filename, original):
    assert held_for(c, filename, "DUPLICATE_INVOICE")["details"]["duplicate_of"] == original


def polar_000961_duplicate_of_AP00393(c):
    duplicate(c, "Invoice 000961.pdf", "AP-00393")


def harlow_001468_duplicate_of_AP00389(c):
    duplicate(c, "harlowsternllp_001468.pdf", "AP-00389")


def cloudbarn_INV01561_duplicate_already_paid_by_card(c):
    duplicate(c, "cloudbarnsoftwar_INV01561.pdf", "AP-00370")
    assert "Paid by card" in checks(c, invoice(c, "cloudbarnsoftwar_INV01561.pdf"))["DUPLICATE_INVOICE"]["message"]


def voyageur_000903A_reformatted_duplicate_of_AP00277(c):
    duplicate(c, "voyageurcorporat-inv-017.pdf", "AP-00277")


def brightline_583_reformatted_duplicate_of_AP00330(c):
    duplicate(c, "brightlinesafety-inv-032.pdf", "AP-00330")


# ── 3. duplicates and double payments in the history ──

def history_AP00394_AP00407_about_to_be_paid_twice(c):
    assert any(f["kind"] == "about_to_pay_twice" and set(f["invoice_ids"]) == {"AP-00394", "AP-00407"}
               for f in findings.double_payments(c))


def history_paid_twice_by_eft(c):
    groups = [set(f["invoice_ids"]) for f in findings.double_payments(c) if f["kind"] == "paid_twice"]
    for pair in ({"AP-00023", "AP-00034"}, {"AP-00073", "AP-00077"}, {"AP-00136", "AP-00155"}, {"AP-00215", "AP-00224"}):
        assert pair in groups, f"missed {pair}"


def history_paid_by_eft_and_employee_card(c):
    cards = {f["payment_ids"][1] for f in findings.double_payments(c) if f["kind"] == "paid_by_ap_and_card"}
    assert {"CT-00017", "CT-00026", "CT-00318", "CT-00383", "CT-00324", "CT-00551"} <= cards


def history_AL26_0663_paid_three_times(c):
    hits = [f for f in findings.double_payments(c) if "AP-00224" in f["invoice_ids"] or "AP-00215" in f["invoice_ids"]]
    assert sum(len(f["payment_ids"]) for f in hits) >= 3


def history_overpaid_about_23_6k(c):
    total = sum(f["overpaid_cad_cents"] for f in findings.double_payments(c) if f["kind"] != "about_to_pay_twice")
    assert 2_330_000 <= total <= 2_390_000, total


# ── 4. money, tax and contracts ──

def evergreen_000850_total_100_off(c):
    assert held_for(c, "evergreenenergyu_000850.pdf", "TOTAL_DOESNT_ADD_UP")["details"]["difference_cents"] == 10_000


def northstar_NO26_1773_line_24x150_not_3800(c):
    held_for(c, "northstarmediabu_NO261773.pdf", "LINE_AMOUNT_WRONG")


def polar_000964_fuel_surcharge_22_over_12_cap(c):
    held_for(c, "Invoice 000964.pdf", "FUEL_SURCHARGE_OVER_CAP")


def northbound_000639_hst_charged_in_alberta(c):
    held_for(c, "northboundcourie_000639.pdf", "WRONG_TAX_FOR_PROVINCE")


def ironwood_INV02210_no_tax_on_ontario_goods(c):
    assert held_for(c, "ironwoodpalletco-inv-048.pdf", "TAX_MISSING")["details"]["tax_code"] == "HST13"


def beaumont_FA000557_no_qst_in_quebec(c):
    assert held_for(c, "beaumontrivieres_FA000557.pdf", "TAX_MISSING")["details"]["tax_code"] == "QST9975"


def signal_sparrow_000970_pst_on_services(c):
    held_for(c, "signalsparrowcre_000970.pdf", "PST_ON_SERVICES")


def aurora_AU26_2207_over_fixed_fee(c):
    held_for(c, "Invoice AU26-2207.pdf", "OVER_FIXED_FEE")


def pinecone_PI26_2809_over_fixed_fee(c):
    held_for(c, "pineconecollabor_PI262809.pdf", "OVER_FIXED_FEE")


def lattice_557_implementation_not_covered_by_contract(c):
    held_for(c, "latticeledgersys_557.pdf", "OVER_FIXED_FEE")


def summit_000809_future_dated(c):
    held_for(c, "Invoice 000809.pdf", "FUTURE_DATED")


def lumen_FA001761_stale(c):
    held_for(c, "lumenprintsignag_FA001761.pdf", "STALE_INVOICE")


def prairie_scan_ocr_misread_transit_sent_to_a_person(c):
    inv = invoice(c, "scan_8749.png")
    x = c.execute("SELECT field_confidence FROM extractions WHERE document_id = %s", (inv["document_id"],)).fetchone()
    assert "$5541" in x["field_confidence"]["bank_transit"]["note"]
    assert inv["status"] == "needs_review"
    stored = c.execute("SELECT * FROM check_results WHERE invoice_id = %s", (inv["invoice_id"],)).fetchall()
    assert any("Transit" in r for r in review_reasons(c, inv, stored))


def torque_1771_contract_expired_and_over_po(c):
    held_for(c, "torqueindustrial_1771.pdf", "CONTRACT_EXPIRED")
    assert "PO_OVER_BALANCE" in checks(c, invoice(c, "torqueindustrial_1771.pdf"))


# ── 5. approval rules ──

def orion_279_281_287_split_to_stay_under_10k(c):
    for f in ("orionstrategypar-inv-029.pdf", "orionstrategypar_281.pdf", "Invoice 287.pdf"):
        assert "SPLIT_INVOICE" in checks(c, invoice(c, f)), f


def history_splits_northstar_and_deskhive(c):
    groups = [set(s["invoice_ids"]) for s in findings.split_invoices(c)]
    assert {"AP-00303", "AP-00304"} in groups
    assert {"AP-00120", "AP-00129", "AP-00131"} in groups


def history_self_approvals_by_U010(c):
    found = {(r["invoice_id"], r["approver_user_id"]) for r in findings.self_approvals(c)}
    assert {("AP-00092", "U010"), ("AP-00178", "U010"), ("AP-00235", "U010")} <= found


def queen_street_002935_delegation_clash_and_separation_of_duties(c):
    inv = invoice(c, "Invoice 002935.pdf")
    steps = c.execute("SELECT * FROM approvals WHERE invoice_id = %s ORDER BY step_no", (inv["invoice_id"],)).fetchall()
    # Liam (U012) is on leave; his delegate Elise (U003) is also the finance manager, so step 1 goes to Liam's
    # manager (U001) and Elise keeps step 2. She can't fill both.
    assert [s["approver_user_id"] for s in steps] == ["U001", "U003"]
    approved = approve_all(c, inv)
    people = users(c)
    payment = payments.prepare(c, approved, people["U004"])
    resource = payment_resource(c, payment)
    assert not can(c, people["U003"], "payment.release", resource).allowed      # approved it (P11)
    assert not can(c, people["U004"], "payment.release", resource).allowed      # AP clerk (P09)
    assert can(c, people["U002"], "payment.release", resource).allowed          # controller can


# ── 6. PO matching (no incoming invoice prints a PO number) ──

def po(c, filename):
    return invoice(c, filename)["po_id"]


def keystone_matched_to_open_PO0046(c):
    assert po(c, "keystonerackings-inv-002.pdf") == "PO-2026-0046"


def summit_over_PO0052_with_tax(c):
    assert po(c, "Invoice 000809.pdf") == "PO-2026-0052"
    assert "PO_OVER_BALANCE" in checks(c, invoice(c, "Invoice 000809.pdf"))


def alpenglow_over_PO0050_with_tax(c):
    assert po(c, "alpengloweventsc-inv-010.pdf") == "PO-2026-0050"
    assert "PO_OVER_BALANCE" in checks(c, invoice(c, "alpengloweventsc-inv-010.pdf"))


def ironwood_riverbend_fixwell_within_their_POs(c):
    for filename, po_id in (("ironwoodpalletco-inv-048.pdf", "PO-2026-0051"), ("riverbendcaterin_1739.pdf", "PO-2026-0047"),
                            ("fixwellfacilitys-inv-052.pdf", "PO-2026-0049")):
        inv = invoice(c, filename)
        assert inv["po_id"] == po_id and "PO_MATCHED" in checks(c, inv), filename


def torque_over_PO0037_remaining(c):
    assert po(c, "torqueindustrial_1771.pdf") == "PO-2026-0037"


def hardhat_853_and_brightline_583_no_open_po_held(c):
    held_for(c, "Invoice 853.pdf", "PO_MISSING")
    held_for(c, "brightlinesafety-inv-032.pdf", "PO_MISSING")


# ── 7. credit notes ──

def fixwell_credit_note_deducted_from_next_payment(c):
    people = users(c)
    cn = invoice(c, "fixwellfacilitys_CNFA000413.pdf")
    assert cn["is_credit_note"] and checks(c, cn)["CREDIT_NOTE_REVERSES"]["details"]["original"] == "AP-00383"
    approve_all(c, cn)
    nxt = approve_all(c, invoice(c, "fixwellfacilitys-inv-052.pdf"))
    payment = payments.prepare(c, nxt, people["U004"])
    assert payment["credit_applied_cents"] == 161_421
    assert payment["amount_cents"] == nxt["total_cents"] - 161_421
    assert c.execute("SELECT status FROM invoices WHERE invoice_id = %s", (cn["invoice_id"],)).fetchone()["status"] == "paid"


def great_lakes_credit_note_refers_to_GR26_2262(c):
    cn = invoice(c, "greatlakescarrie-inv-025.pdf")
    assert cn["is_credit_note"] and checks(c, cn)["CREDIT_NOTE_REVERSES"]["details"]["original"] == "AP-00358"


# ── 8. inbox ──

def EM059_newsletter_ignored(c):
    assert email(c, "EM-059")["classification"] == "newsletter"


def EM056_statement_filed_no_invoice(c):
    assert email(c, "EM-056")["classification"] == "statement"
    assert not c.execute("SELECT 1 FROM invoices WHERE email_id = 'EM-056'").fetchone()


def EM058_missing_attachment(c):
    assert email(c, "EM-058")["classification"] == "missing_attachment"


def EM057_payment_question_answered_PAY00047(c):
    e = email(c, "EM-057")
    assert e["classification"] == "payment_inquiry"
    assert "PAY-00047" in e["intake_note"] and "March 9, 2026" in e["intake_note"]


def EM029_two_invoices_from_one_email(c):
    numbers = {r["vendor_invoice_number"] for r in c.execute("SELECT * FROM invoices WHERE email_id = 'EM-029'")}
    assert numbers == {"279", "281"}


def french_documents_read_per_document(c):
    inv = invoice(c, "laurentianlogist_FA002399.pdf")
    x = c.execute("SELECT fields FROM extractions WHERE document_id = %s", (inv["document_id"],)).fetchone()
    assert x["fields"]["language"] == "fr" and inv["total_cents"] == 501_598


# ── 9. USD invoices ──

def usd_invoices_converted_at_invoice_date_rate(c):
    for filename in ("sparkgridcrminc_FA002342.pdf", "tesseraanalytics-inv-050.pdf"):
        inv = invoice(c, filename)
        rate = c.execute("SELECT usd_to_cad FROM fx_rates WHERE date = %s", (inv["invoice_date"],)).fetchone()["usd_to_cad"]
        assert inv["currency"] == "USD" and inv["total_cad_cents"] == apply_rate(inv["total_cents"], rate)
        assert "TAX_OK" in checks(c, inv), filename   # foreign vendor, no Canadian tax


TRAPS = [v for k, v in dict(globals()).items() if callable(v) and getattr(v, "__module__", "") == __name__
         and not k.startswith("_") and k not in {"invoice", "checks", "held_for", "users", "approve_all", "email",
                                                 "duplicate", "po", "test_trap"}]


@pytest.mark.parametrize("trap", TRAPS, ids=[t.__name__ for t in TRAPS])
def test_trap(trap, pconn):
    trap(pconn)
