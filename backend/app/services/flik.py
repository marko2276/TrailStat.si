"""Flik: Slovenian instant payments between people, sent from a banking app to a phone number.
The app only shows the number; the payer sends the money in their own banking app."""

import re

_NATIONAL = re.compile(r"^0(\d{8})$")
_INTERNATIONAL = re.compile(r"^(?:\+|00)386(\d{8})$")


def normalise_flik_number(number: str) -> str:
    """A Slovenian phone number in its national form, grouped as people read it: 041 123 456.
    Raises ValueError for anything else: Flik works only with Slovenian numbers."""
    compact = re.sub(r"[\s\-/().]", "", number)
    match = _NATIONAL.match(compact) or _INTERNATIONAL.match(compact)
    if match is None:
        raise ValueError("the Flik number is not a Slovenian phone number")
    digits = "0" + match.group(1)
    return f"{digits[:3]} {digits[3:6]} {digits[6:]}"
