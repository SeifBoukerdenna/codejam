"""Show the math (app/breakdowns.py): the parts always add up, and the gaps are where the traps are."""

from app.breakdowns import breakdown, invoice_math, top_parts
from app.checks.context import build_context


def test_a_gap_becomes_its_own_part():
    b = breakdown([("Subtotal", 300000), ("GST 5%", 15000)], 325000, gap_label="Not explained")
    assert b["parts"][-1] == {"label": "Not explained", "cents": 10000}
    assert sum(p["cents"] for p in b["parts"]) == b["total_cents"]
    assert len(breakdown([("A", 5)], 5)["parts"]) == 1            # nothing to explain: no extra line


def test_long_lists_keep_the_biggest_and_sum_the_rest():
    parts = top_parts([("a", 1), ("b", 50), ("c", 3), ("d", 40), ("e", 2), ("f", 30)], keep=3, rest="{n} more")
    assert parts == [("b", 50), ("d", 40), ("f", 30), ("3 more", 6)]


def _math(pconn, number):
    inv = pconn.execute("SELECT invoice_id FROM invoices WHERE vendor_invoice_number = %s AND source <> 'history'",
                        (number,)).fetchone()["invoice_id"]
    return invoice_math(build_context(pconn, inv))


def test_every_breakdown_adds_up_on_every_invoice(pconn):
    ids = [r["invoice_id"] for r in pconn.execute("SELECT invoice_id FROM invoices ORDER BY invoice_id")]
    for invoice_id in ids:
        m = invoice_math(build_context(pconn, invoice_id))
        found = [m["total"], m["subtotal"], m["po"], *m["taxes"].values(), *m["lines"].values()]
        for b in filter(None, found):
            assert sum(p["cents"] for p in b["parts"]) == b["total_cents"], (invoice_id, b)


def test_evergreen_total_is_100_dollars_off(pconn):
    total = _math(pconn, "000850")["total"]
    assert total["parts"][-1] == {"label": "Not explained by the subtotal and tax", "cents": 10000}


def test_northstar_24_times_150_is_not_3800(pconn):
    line = _math(pconn, "NO26-1773")["lines"][1]
    assert [p["cents"] for p in line["parts"]] == [360000, 20000]
    assert line["parts"][0]["label"].startswith("24 × $150.00")


def test_summit_is_over_its_po_with_tax(pconn):
    m = _math(pconn, "000809")
    assert m["po_id"] == "PO-2026-0052" and m["po"]["total_cents"] == 550000
    assert "this invoice is $248.75 CAD over" in m["total"]["note"]


def test_pst_on_services_is_all_overcharge(pconn):
    pst = _math(pconn, "000970")["taxes"]["pst_qst"]
    assert pst["parts"] == [{"label": "7% of $0.00 CAD (goods only)", "cents": 0},
                            {"label": "Charged more than the rate", "cents": 58800}]


def test_page_totals_match_their_breakdowns(api, pconn):
    home = api("GET", "/home", "U004").json()
    assert home["paid_this_year_breakdown"]["total_cents"] == home["paid_this_year_cad_cents"]
    assert sum(p["cents"] for p in home["paid_this_year_breakdown"]["parts"]) == home["paid_this_year_cad_cents"]
    assert home["bank_in_question_breakdown"]["total_cents"] == home["bank_in_question_cents"]
    f = api("GET", "/findings", "U004").json()
    assert f["to_recover_breakdown"]["total_cents"] == f["to_recover_cad_cents"] == 2360192
    assert f["overpaid_breakdown"]["total_cents"] == f["overpaid_cad_cents"]
    assert f["tax_at_risk_breakdown"]["total_cents"] == f["tax_at_risk_cents"]
    bank = api("GET", "/bank", "U004").json()
    assert bank["in_question_breakdown"]["total_cents"] == bank["in_question_cents"]
    for b in (home["bank_in_question_breakdown"], f["to_recover_breakdown"], f["tax_at_risk_breakdown"]):
        assert sum(p["cents"] for p in b["parts"]) == b["total_cents"]
