"""UPN QR: the QR code of the Slovenian payment order (UPN), which Slovenian banking apps scan to
fill in a payment. Used for donations: the money goes straight to the payee's bank account, and
the app never sees it.

The content follows the UPN QR standard of the Bank Association of Slovenia (ZBS, upn-qr.si):
19 fields, each ending in a line feed, then a control sum (the length of all that, as three
digits), a line feed, and an empty reserved field. The text is ISO-8859-2, announced with ECI 4,
in a version 15 code with error correction M.
"""

import io
import re
from dataclasses import dataclass
from functools import lru_cache

import segno

ENCODING = "iso-8859-2"
# "Other". The standard's purpose codes have none for a gift to a person.
PURPOSE_CODE = "OTHR"
# "SI99": the payment has no reference.
NO_REFERENCE = "SI99"

MAX_NAME = 33
MAX_PURPOSE = 42
# Bounded so a typo cannot ask for a fortune. The field itself takes up to 11 digits of cents.
MAX_AMOUNT_CENTS = 1_000_000
MIN_AMOUNT_CENTS = 100

_IBAN = re.compile(r"^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$")


class PayeeError(ValueError):
    """The payee's details cannot go on a UPN."""


def normalise_iban(iban: str) -> str:
    return re.sub(r"\s+", "", iban).upper()


def format_iban(iban: str) -> str:
    """In groups of four, as people read and type it: SI56 0201 7001 4356 205."""
    return " ".join(iban[i : i + 4] for i in range(0, len(iban), 4))


def _iban_is_valid(iban: str) -> bool:
    if not _IBAN.match(iban):
        return False
    rearranged = iban[4:] + iban[:4]
    digits = "".join(str(int(char, 36)) for char in rearranged)
    return int(digits) % 97 == 1


@dataclass(frozen=True)
class Payee:
    """Who receives the payment, and what the payment is for."""

    iban: str
    name: str
    city: str
    street: str = ""
    purpose: str = "Donacija TrailStat.si"

    def __post_init__(self) -> None:
        problems = self.problems()
        if problems:
            raise PayeeError("; ".join(problems))

    def problems(self) -> list[str]:
        problems = []
        if not _iban_is_valid(self.iban):
            problems.append("the IBAN is not valid (written without spaces, in capitals)")
        for label, value, required, limit in (
            ("name", self.name, True, MAX_NAME),
            ("city", self.city, True, MAX_NAME),
            ("street", self.street, False, MAX_NAME),
            ("purpose", self.purpose, True, MAX_PURPOSE),
        ):
            if required and not value.strip():
                problems.append(f"the {label} is required")
            if len(value) > limit:
                problems.append(f"the {label} is longer than {limit} characters")
            if any(char in value for char in "\r\n"):
                problems.append(f"the {label} has a line break")
            try:
                value.encode(ENCODING)
            except UnicodeEncodeError:
                problems.append(f"the {label} has characters a UPN cannot hold")
        return problems


def payload(payee: Payee, amount_cents: int | None = None) -> str:
    """The text in the QR code. Without an amount, the payer enters one."""
    if amount_cents is not None and not MIN_AMOUNT_CENTS <= amount_cents <= MAX_AMOUNT_CENTS:
        raise ValueError(f"amount out of range: {amount_cents}")
    fields = [
        "UPNQR",
        "",  # the payer's IBAN
        "",  # deposit
        "",  # withdrawal
        "",  # the payer's reference
        "",  # the payer's name
        "",  # the payer's street
        "",  # the payer's city
        "" if amount_cents is None else f"{amount_cents:011d}",
        "",  # payment date
        "",  # urgent
        PURPOSE_CODE,
        payee.purpose,
        "",  # due date
        payee.iban,
        NO_REFERENCE,
        payee.name,
        payee.street,
        payee.city,
    ]
    text = "".join(f"{field}\n" for field in fields)
    return f"{text}{len(text):03d}\n"


def qr_code(payee: Payee, amount_cents: int | None = None) -> segno.QRCode:
    return segno.make_qr(
        payload(payee, amount_cents),
        version=15,
        error="m",
        boost_error=False,
        mode="byte",
        encoding=ENCODING,
        eci=True,
    )


@lru_cache(maxsize=128)
def svg(payee: Payee, amount_cents: int | None = None) -> str:
    """The QR code as an SVG image. Cached: a page shows the same few codes over and over."""
    code = qr_code(payee, amount_cents)
    out = io.BytesIO()
    # Four modules of white around it, as every QR code needs to be found by a camera.
    code.save(out, kind="svg", scale=4, border=4, xmldecl=False, title="UPN QR")
    return out.getvalue().decode()
