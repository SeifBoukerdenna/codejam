"""Cmd+K search (app/search.py): every typed word must match, invoice numbers compare like the duplicate check."""

import pytest

from app.search import amount_range, invoice_points


@pytest.mark.parametrize("word, expected", [
    ("$6,452.30", (645230, 645230)),
    ("6452.3", (645230, 645230)),
    ("18,758", (1875800, 1875899)),
    ("583", (58300, 58399)),
    ("FA-583", None),
    ("1,23", None),
])
def test_what_an_amount_can_mean(word, expected):
    assert amount_range(word) == expected


def test_a_word_that_matches_nothing_scores_zero():
    inv = {"invoice_id": "AP-00001", "vendor_invoice_number": "INV-1", "vendor_name": "Polar Freight Lines Ltd.",
           "total_cents": 1000, "total_cad_cents": 1000}
    assert invoice_points("zephyr", inv) == 0
    assert invoice_points("pol", inv) == 40          # the start of a word in the vendor's name


def found(api, q):
    return api("GET", "/search", "U004", params={"q": q}).json()


def test_reformatted_numbers_find_both_copies_of_a_duplicate(api, pconn):
    numbers = {i["vendor_invoice_number"] for i in found(api, "583")["invoices"]}
    assert {"FA-000583", "583"} <= numbers                     # Brightline: history and the re-sent one
    polar = found(api, "961")["invoices"]
    assert {i["invoice_id"] for i in polar} >= {"AP-00393"} and len(polar) == 2


def test_vendor_and_number_together_narrow_it_down(api, pconn):
    hits = found(api, "orion 279")["invoices"]
    assert [i["vendor_invoice_number"] for i in hits] == ["279"]


def test_an_amount_finds_the_invoice(api, pconn):
    hits = found(api, "$18,758")["invoices"]
    assert hits and all(i["total_cents"] // 100 == 18758 for i in hits)
    assert hits[0]["vendor_invoice_number"] == "002935"        # the newest of Queen Street's monthly rent


def test_look_alike_vendors_both_show_up(api, pconn):
    names = [v["legal_name"] for v in found(api, "harlow")["vendors"]]
    assert names == ["Harlow & Stern LLP", "Harlow and Stern LLP"]


def test_nothing_typed_or_nothing_found(api, pconn):
    assert found(api, "  ") == {"invoices": [], "vendors": []}
    assert found(api, "qqqq") == {"invoices": [], "vendors": []}


def test_the_impostor_is_labelled_in_search_too(api, pconn):
    vendors = {v["legal_name"]: v for v in found(api, "harlow")["vendors"]}
    assert vendors["Harlow and Stern LLP"]["lookalike_of"] == "Harlow & Stern LLP"
    assert vendors["Harlow & Stern LLP"]["lookalike_of"] is None
    assert "bank_account" not in vendors["Harlow & Stern LLP"]
