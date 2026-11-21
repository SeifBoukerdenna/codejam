"""'Try to fool us': ready-made tricks a judge can launch with one click.

This is a DEMO SCRIPT, which is the one place vendor ids are hard-coded (CLAUDE.md conventions). Each trick
forges a realistic invoice from a real vendor's details (name, address, GST number, bank account all read from
the vendor master) with exactly one thing wrong, then drops it into the normal intake: the same worker, parser,
checks and routing as any real invoice. Nothing here knows how the checks work; if a check were removed, the
trick would get through and the page would say so.
"""

from datetime import date, timedelta

from app import config, intake
from app.demo.fakepdf import pdf_from_lines
from app.money import apply_rate
from app.routes.vendors import record_bank_change

HARBORLINE = {
    "ON": "88 Queens Quay W, Suite 1400, Toronto ON M5J 0B8",
    "QC": "1250 Rene-Levesque O, Bureau 2200, Montreal QC H3B 4W8",
    "BC": "1055 W Hastings St, Suite 900, Vancouver BC V6E 2E9",
    "AB": "250 6 Ave SW, Suite 700, Calgary AB T2P 3H7",
}

# key: (title, what the fake does). Order = order on the page. What catches each one is deliberately NOT
# written here: the page shows whatever the real checks said, so it can't claim a defense that didn't fire.
SCENARIOS = {
    "bank-swap": ("Swap the bank account", "A normal Polar Freight invoice that asks to be paid into a new account."),
    "impostor": ("Pose as a real vendor",
                 "Uses Queen Street Properties' exact name, with someone else's GST number and bank account."),
    "reused-number": ("Bill a paid invoice again",
                      "Queen Street's January rent, already paid, sent again as #QS-2897 instead of #002897."),
    "wrong-tax": ("Charge the wrong tax", "Stampede Trail rent for our Calgary yard, with 13% Ontario HST instead of 5% GST."),
    "padded-total": ("Pad the total", "A Lakeshore Hydro bill whose total is $500 more than its lines and tax add up to."),
    "over-contract": ("Bill over the contract", "Cloudbarn charges $2,950 for a subscription fixed at $2,400 a month."),
    "future-date": ("Date it in the future", "A Trailhead Fuel invoice dated December 15, six weeks from today."),
    "split": ("Split it to dodge approval",
              "A $12,204 Lumen Print job sent as two invoices ($6,480 and $5,724), each under the $10,000 limit."),
    "bank-email": ("Change bank details by email",
                   "An email asks us to pay Fixwell Facility Services into a new account from now on."),
}


def _money(cents: int) -> str:
    return f"${cents / 100:,.2f}"


def _invoice_lines(v: dict, number: str, issued: date, lines: list[tuple[str, int, int]], tax: tuple[str, str, int] | None,
                   *, bill_to: str = "ON", total: int | None = None, gst: str | None = None,
                   bank: tuple[str, str, str] | None = None, card_only: bool = False) -> list[str]:
    """The text of one invoice page, in the layout most of the dataset's vendors use."""
    address, city = (v["address"].split(", ", 1) + [""])[:2]
    subtotal = sum(qty * unit for _, qty, unit in lines)
    tax_cents = tax[2] if tax else 0
    total = subtotal + tax_cents if total is None else total
    inst, transit, acct = bank or (v["bank_institution"], v["bank_transit"], v["bank_account"])
    gst_line = f"GST/HST {gst or v['gst_hst_number']}"
    out = [
        f"{v['legal_name']:<52}INVOICE",
        f"{address:<52}Invoice #: {number}",
        f"{city:<52}Date: {issued.isoformat()}",
        f"{gst_line:<52}Due date: {(issued + timedelta(days=30)).isoformat()}",
        f"{'':<52}Terms: Net 30",
        "",
        "Bill to",
        "Harborline Logistics Inc.",
        HARBORLINE[bill_to],
        "GST/HST 100000001RT0001",
        "",
        f"{'Description':<46}{'Qty':>4}{'Unit price':>15}{'Amount':>15}",
    ]
    for desc, qty, unit in lines:
        out.append(f"{desc:<46}{qty:>4}{_money(unit):>15}{_money(qty * unit):>15}")
    out += ["", f"{'':<46}{'Subtotal':<12}{_money(subtotal):>22}"]
    if tax:
        out.append(f"{'':<46}{f'{tax[0]} ({tax[1]}%)':<12}{_money(tax_cents):>22}")
    out += [f"{'':<46}{'Total CAD':<12}{_money(total):>22}", "", "Remit to"]
    if card_only:
        out.append("Pay by credit card at our online portal.")
    else:
        out += [f"Inst. {inst}   Transit {transit}   Acct {acct}", f"EFT / virement bancaire - {v['legal_name']}"]
    out += ["", "Thank you for your business."]
    return out


def _hst(cents: int) -> tuple[str, str, int]:
    return ("HST", "13", apply_rate(cents, "0.13"))


def build(conn, key: str, attempt: int) -> list[tuple[str, bytes]]:
    """Return [(filename, pdf bytes)] for one trick. `attempt` keeps invoice numbers unique between tries."""
    vendors = {r["vendor_id"]: r for r in conn.execute("SELECT * FROM vendors")}
    today = config.TODAY
    n = 7000 + attempt

    if key == "bank-swap":
        freight = [("LTL shipment Toronto-Montreal", 1, 84210), ("LTL shipment Hamilton-Ottawa", 1, 121540),
                   ("LTL shipment Toronto-Windsor", 1, 63075)]
        fuel = apply_rate(sum(u for _, _, u in freight), "0.09")
        lines = freight + [("Fuel surcharge (9%)", 1, fuel)]
        sub = sum(u for _, _, u in lines)
        return [(f"fool-{key}-{attempt}.pdf", pdf_from_lines(_invoice_lines(vendors["V001"], f"00{n}", today, lines, _hst(sub),
                                                                 bank=("002", "31415", "88120455"))))]
    if key == "impostor":
        lines = [("Parking - November", 1, 125000)]
        return [(f"fool-{key}-{attempt}.pdf", pdf_from_lines(_invoice_lines(vendors["V036"], f"00{n}", today, lines, _hst(125000),
                                                                 gst="781234569RT0001", bank=("010", "60021", "55918236"))))]
    if key == "reused-number":
        lines = [("Base rent - Toronto HQ", 1, 1450000), ("Operating costs (CAM) - Toronto HQ", 1, 210000)]
        return [(f"fool-{key}-{attempt}.pdf", pdf_from_lines(_invoice_lines(vendors["V036"], "QS-2897", today, lines, _hst(1660000))))]
    if key == "wrong-tax":
        lines = [("Base rent - Calgary yard", 1, 1060000)]
        return [(f"fool-{key}-{attempt}.pdf", pdf_from_lines(_invoice_lines(vendors["V038"], f"SP-{n}", today, lines, _hst(1060000),
                                                                 bill_to="AB")))]
    if key == "padded-total":
        lines = [("Electricity - October", 1, 438001)]
        tax = _hst(438001)
        return [(f"fool-{key}-{attempt}.pdf", pdf_from_lines(_invoice_lines(vendors["V040"], f"INV-0{n}", today, lines, tax,
                                                                 total=438001 + tax[2] + 50000)))]
    if key == "over-contract":
        lines = [("Cloudbarn Workspace subscription (30 seats)", 1, 295000)]
        return [(f"fool-{key}-{attempt}.pdf", pdf_from_lines(_invoice_lines(vendors["V015"], f"INV-0{n}", today, lines, _hst(295000),
                                                                 card_only=True)))]
    if key == "future-date":
        lines = [("Fleet fuel card charges - November", 1, 412000)]
        return [(f"fool-{key}-{attempt}.pdf", pdf_from_lines(_invoice_lines(vendors["V007"], f"TR26-{n}", date(today.year, 12, 15),
                                                                 lines, _hst(412000))))]
    if key == "split":
        # Uneven halves, like a real splitter: equal ones would also look like a plain duplicate.
        files = []
        for part, (desc, cents) in enumerate([("Trade show banners", 573451), ("Trade show booth signage", 506549)], 1):
            files.append((f"fool-{key}-{attempt}-{part}.pdf",
                          pdf_from_lines(_invoice_lines(vendors["V033"], f"FA-00{n}{part}", today, [(desc, 1, cents)], _hst(cents)))))
        return files
    raise KeyError(key)


def launch(conn, key: str, user: dict) -> dict:
    """Run one trick as `user`. Invoices go into the normal queue; the bank change goes through the normal API logic."""
    attempt = conn.execute("SELECT count(*) + 1 AS n FROM documents WHERE filename LIKE 'fool-%'").fetchone()["n"]
    if key == "bank-email":
        change_id = record_bank_change(conn, "V043", user, "006", "40172", "61839027", "email_request",
                                       note="Try to fool us: email from ar@fixwell-facility.example asking for new bank details")
        return {"kind": "bank_change", "change_id": change_id}
    ids = []
    for filename, content in build(conn, key, attempt):
        doc_id, _ = intake.store_document(conn, filename=filename, content=content, source="upload",
                                          uploaded_by=user["user_id"])
        ids.append(doc_id)
    return {"kind": "invoice", "document_ids": ids}


def scenario_of(filename: str) -> str | None:
    """'fool-split-12-1.pdf' -> 'split'. Anything else is a judge's own upload."""
    if not filename.startswith("fool-"):
        return None
    rest = filename[len("fool-"):]
    return next((k for k in SCENARIOS if rest.startswith(k + "-")), None)
