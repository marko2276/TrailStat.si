"""Donations by bank transfer. The app only shows where to send money, with a UPN QR code that
banking apps scan: no payment passes through it, and nothing about a donation is stored.

Readable without an account, so the support page works before signing in.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel

from app.config import get_settings
from app.errors import ApiError
from app.services import upn_qr
from app.services.upn_qr import Payee

router = APIRouter(prefix="/donations", tags=["donations"])


def get_donation_payee() -> Payee | None:
    return get_settings().donation_payee


def _require_payee(payee: Annotated[Payee | None, Depends(get_donation_payee)]) -> Payee:
    if payee is None:
        raise ApiError(404, "donations_off")
    return payee


DonationPayee = Annotated[Payee, Depends(_require_payee)]


class DonationDetails(BaseModel):
    """What a payer types in by hand, without the QR code."""

    iban: str
    name: str
    street: str | None
    city: str
    purpose: str
    reference: str


@router.get("")
def donation_details(payee: DonationPayee) -> DonationDetails:
    return DonationDetails(
        iban=upn_qr.format_iban(payee.iban),
        name=payee.name,
        street=payee.street or None,
        city=payee.city,
        purpose=payee.purpose,
        reference=upn_qr.NO_REFERENCE,
    )


@router.get("/upn-qr.svg", response_class=Response)
def donation_qr(
    payee: DonationPayee,
    amount_cents: Annotated[
        int | None, Query(ge=upn_qr.MIN_AMOUNT_CENTS, le=upn_qr.MAX_AMOUNT_CENTS)
    ] = None,
) -> Response:
    """The UPN QR code, with this amount, or for the payer to enter one."""
    return Response(
        upn_qr.svg(payee, amount_cents),
        media_type="image/svg+xml",
        # The same for everyone, until the settings change with a restart.
        headers={"Cache-Control": "public, max-age=3600"},
    )
