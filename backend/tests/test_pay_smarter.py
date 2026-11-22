"""Pay smarter (app/pay_smarter.py): deterministic advice, and the year's missed discounts match a hand count."""

from datetime import date
from decimal import Decimal

from app.pay_smarter import discount_terms, suggest

TODAY = date(2026, 11, 2)
PAPER_TRAIL = {"legal_name": "Paper Trail Office Supply", "early_pay_discount": "2/10 net 30", "accepts_card_payment": True,
               "preferred_payment_method": "EFT"}
NORTHBOUND = {"legal_name": "Northbound Couriers", "early_pay_discount": None, "accepts_card_payment": False,
              "preferred_payment_method": "EFT"}


def invoice(**kw):
    return {"invoice_date": date(2026, 10, 26), "due_date": date(2026, 11, 25), "subtotal_cents": 55000,
            "total_cents": 61264, "currency": "CAD", **kw}


def test_terms():
    assert discount_terms("2/10 net 30") == (Decimal("0.02"), 10)
    assert discount_terms("net 30") is None and discount_terms(None) is None


def test_open_discount_window_wins():
    s = suggest(invoice(), PAPER_TRAIL, TODAY)
    assert s["date"] == "2026-11-05" and s["saves_cents"] == 1100                 # 2% of $550.00 before tax
    assert s["pay_cents"] == 61264 - 1100 and s["method"] == "CARD"
    assert "gives 2% off" in s["reason"] and "$601.64 CAD instead of $612.64 CAD" in s["reason"]


def test_closed_window_falls_back_to_card_on_the_due_date():
    s = suggest(invoice(invoice_date=date(2026, 10, 1)), PAPER_TRAIL, TODAY)
    assert (s["method"], s["date"], s["saves_cents"]) == ("CARD", "2026-11-25", 0)
    assert "closed on Oct 11" in s["reason"] and "23 more days" in s["reason"]


def test_no_card_means_transfer_on_the_due_date_not_earlier():
    s = suggest(invoice(), NORTHBOUND, TODAY)
    assert (s["method"], s["date"]) == ("EFT", "2026-11-25")
    overdue = suggest(invoice(due_date=date(2026, 10, 30)), NORTHBOUND, TODAY)
    assert overdue["date"] == "2026-11-02" and "3 days overdue" in overdue["reason"]


def test_same_input_same_advice():
    assert suggest(invoice(), PAPER_TRAIL, TODAY) == suggest(invoice(), PAPER_TRAIL, TODAY)


def test_missed_discounts_match_a_hand_count(api, pconn):
    # By hand from payments.csv: the 10 payments to 2/10 vendors made after day 10 with no discount, 2% of each
    # pre-tax subtotal: 120.83 + 9.99 + 60.96 + 87.83 + 201.93 + 44.88 + 110.16 + 142.16 + 27.10 + 21.93 = $827.77.
    year = api("GET", "/payments/suggestions", "U004").json()["year"]
    assert year["discounts_missed"] == {**year["discounts_missed"], "count": 10, "cents": 82777}
    assert year["discounts_taken"] == {"count": 9, "cents": 29618}
    assert year["rewards_cents"] is None                                            # no rate set: nothing invented


def test_a_vendor_with_an_unverified_bank_change_is_flagged(api, pconn):
    held = {s["vendor_name"]: s["held"] for s in api("GET", "/payments/suggestions", "U004").json()["suggestions"]}
    assert "confirmed by phone" in held["Cascadia Cartage Ltd."]
    assert held["Northbound Couriers"] is None
