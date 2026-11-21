"""Validation checks. Every check is a pure function: (ctx) -> list[CheckResult].

ctx is a plain dict built once per invoice by context.py (all the database reads happen there), so each
check can be unit-tested with a hand-made dict and gives the same answer every time.

Severity: 'block' = can't proceed; 'warn' = a person must acknowledge it; 'info' = for the record.
"""

from dataclasses import asdict, dataclass, field


@dataclass
class CheckResult:
    code: str
    severity: str     # block | warn | info
    message: str      # plain-language reason, shown as-is in the UI
    details: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return asdict(self)


def block(code: str, message: str, **details) -> CheckResult:
    return CheckResult(code, "block", message, details)


def warn(code: str, message: str, **details) -> CheckResult:
    return CheckResult(code, "warn", message, details)


def info(code: str, message: str, **details) -> CheckResult:
    return CheckResult(code, "info", message, details)
