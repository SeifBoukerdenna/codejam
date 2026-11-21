"""Money helpers. All amounts in the app are integer cents.

Decimal is used only at the edges (parsing text, multiplying by a tax or FX rate), then converted back to
cents with one explicit rounding rule, so every tax figure can be reproduced by hand in the Q&A.
"""

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

CENT = Decimal("0.01")


def to_cents(text: str | None) -> int | None:
    """Parse a dollar string like '1,234.56' or '-185.71' into cents. Empty -> None.

    Raises on more than 2 decimals instead of silently rounding: the dataset only has 2-decimal amounts,
    so a third decimal means a parsing bug, and we want to hear about it.
    """
    if text is None:
        return None
    cleaned = text.strip().replace(",", "").replace("$", "")
    if cleaned == "":
        return None
    try:
        value = Decimal(cleaned)
    except InvalidOperation as exc:
        raise ValueError(f"not a money amount: {text!r}") from exc
    if value != value.quantize(CENT):
        raise ValueError(f"more than 2 decimals in money amount: {text!r}")
    return int(value * 100)


def apply_rate(cents: int, rate: Decimal | str) -> int:
    """cents × rate, rounded half-up to the cent (the usual invoice rounding: 0.5 cent goes up)."""
    exact = Decimal(cents) * Decimal(rate)
    return int(exact.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def fmt(cents: int | None, currency: str = "CAD") -> str:
    """12345678 -> '$123,456.78 CAD'. For messages shown to people."""
    if cents is None:
        return "—"
    sign = "-" if cents < 0 else ""
    dollars, rem = divmod(abs(cents), 100)
    return f"{sign}${dollars:,}.{rem:02d} {currency}"
