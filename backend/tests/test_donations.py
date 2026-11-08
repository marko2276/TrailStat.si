"""Donations: the UPN QR content, the settings that enable it, and the public endpoints."""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.donations import get_donation_payee, get_flik_number
from app.config import Settings
from app.main import app
from app.services import upn_qr
from app.services.flik import normalise_flik_number
from app.services.upn_qr import Payee, PayeeError

# The example account of the UPN QR documentation, with a valid check number.
IBAN = "SI56020170014356205"
PAYEE = Payee(iban=IBAN, name="Marko Planinec", street="Gorska ulica 1", city="1000 Ljubljana")


def test_payload_follows_the_standard() -> None:
    text = upn_qr.payload(PAYEE, 1000)
    lines = text.split("\n")

    # 19 fields, the control sum, and the empty reserved field after the last line feed.
    assert len(lines) == 21
    assert lines[0] == "UPNQR"
    assert lines[8] == "00000001000"
    assert lines[11] == "OTHR"
    assert lines[12] == "Donacija TrailStat.si"
    assert lines[14:19] == [IBAN, "SI99", "Marko Planinec", "Gorska ulica 1", "1000 Ljubljana"]
    assert lines[20] == ""
    # The control sum is the length of the 19 fields with their line feeds.
    fields_text = "".join(f"{line}\n" for line in lines[:19])
    assert lines[19] == f"{len(fields_text):03d}"


def test_without_an_amount_the_payer_enters_one() -> None:
    assert upn_qr.payload(PAYEE).split("\n")[8] == ""


@pytest.mark.parametrize("amount", [0, 99, upn_qr.MAX_AMOUNT_CENTS + 1])
def test_amounts_out_of_range_are_refused(amount: int) -> None:
    with pytest.raises(ValueError):
        upn_qr.payload(PAYEE, amount)


def test_the_code_is_the_standard_size_and_encoding() -> None:
    payee = Payee(iban=IBAN, name="Žiga Čuk Šef", city="Škofja Loka")
    code = upn_qr.qr_code(payee, 500)

    assert code.version == 15
    assert code.error == "M"
    # Slovenian letters fit ISO-8859-2, one byte each.
    assert "Žiga Čuk Šef".encode(upn_qr.ENCODING) == b"\xaeiga \xc8uk \xa9ef"


def test_the_longest_details_still_fit() -> None:
    payee = Payee(iban=IBAN, name="N" * 33, street="S" * 33, city="C" * 33, purpose="P" * 42)
    assert upn_qr.qr_code(payee, upn_qr.MAX_AMOUNT_CENTS).version == 15


@pytest.mark.parametrize(
    ("changes", "problem"),
    [
        ({"iban": "SI56020170014356206"}, "IBAN"),
        ({"iban": "SI56 0201 7001 4356 205"}, "IBAN"),
        ({"name": ""}, "name is required"),
        ({"city": " "}, "city is required"),
        ({"name": "N" * 34}, "name is longer"),
        ({"purpose": "P" * 43}, "purpose is longer"),
        ({"street": "a\nb"}, "line break"),
        ({"name": "Анна"}, "cannot hold"),
    ],
)
def test_details_that_cannot_go_on_a_upn_are_refused(changes: dict[str, str], problem: str) -> None:
    details = {"iban": IBAN, "name": "Marko", "city": "Ljubljana", **changes}
    with pytest.raises(PayeeError, match=problem):
        Payee(**details)


def test_iban_and_formatting() -> None:
    assert upn_qr.normalise_iban(" si56 0201 7001 4356 205 ") == IBAN
    assert upn_qr.format_iban(IBAN) == "SI56 0201 7001 4356 205"


def test_settings_without_an_iban_turn_donations_off() -> None:
    assert Settings(donation_iban="").donation_payee is None


def test_settings_build_the_payee() -> None:
    settings = Settings(
        donation_iban="si56 0201 7001 4356 205", donation_name=" Marko ", donation_city="Celje"
    )
    assert settings.donation_payee == Payee(iban=IBAN, name="Marko", city="Celje")


def test_wrong_donation_settings_refuse_to_start() -> None:
    """Otherwise donations would go to a wrong account, or banking apps would refuse the code."""
    with pytest.raises(ValidationError, match="DONATION_"):
        Settings(donation_iban="SI56020170014356206", donation_name="M", donation_city="C")


@pytest.mark.parametrize(
    "number", ["041123456", "041 123 456", "041-123-456", "+38641123456", "00386 41 123 456"]
)
def test_flik_numbers_are_shown_in_the_national_form(number: str) -> None:
    assert normalise_flik_number(number) == "041 123 456"


@pytest.mark.parametrize("number", ["41123456", "0411234567", "+43 664 123456", "041 12a 456"])
def test_flik_needs_a_slovenian_number(number: str) -> None:
    with pytest.raises(ValueError, match="Slovenian"):
        normalise_flik_number(number)


def test_settings_for_flik() -> None:
    assert Settings(donation_flik_number="").donation_flik_number_display is None
    assert Settings(donation_flik_number="+386 41 123 456").donation_flik_number_display == (
        "041 123 456"
    )
    with pytest.raises(ValidationError, match="DONATION_"):
        Settings(donation_flik_number="12345")


@pytest.fixture
def donations_client() -> Iterator[TestClient]:
    app.dependency_overrides[get_donation_payee] = lambda: PAYEE
    app.dependency_overrides[get_flik_number] = lambda: None
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_donations_off(donations_client: TestClient) -> None:
    app.dependency_overrides[get_donation_payee] = lambda: None
    app.dependency_overrides[get_flik_number] = lambda: None

    for path in ("/api/donations", "/api/donations/upn-qr.svg"):
        response = donations_client.get(path)
        assert response.status_code == 404
        assert response.json() == {"detail": "donations_off"}


def test_details_need_no_account(donations_client: TestClient) -> None:
    response = donations_client.get("/api/donations")

    assert response.status_code == 200
    assert response.json() == {
        "bank_transfer": {
            "iban": "SI56 0201 7001 4356 205",
            "name": "Marko Planinec",
            "street": "Gorska ulica 1",
            "city": "1000 Ljubljana",
            "purpose": "Donacija TrailStat.si",
            "reference": "SI99",
        },
        "flik": None,
    }


def test_bank_transfer_and_flik(donations_client: TestClient) -> None:
    app.dependency_overrides[get_flik_number] = lambda: "041 123 456"

    flik = donations_client.get("/api/donations").json()["flik"]
    assert flik == {"number": "041 123 456", "message": "Donacija TrailStat.si"}


def test_flik_alone(donations_client: TestClient) -> None:
    """Without a bank account there are details, but no QR code."""
    app.dependency_overrides[get_donation_payee] = lambda: None
    app.dependency_overrides[get_flik_number] = lambda: "041 123 456"

    options = donations_client.get("/api/donations").json()
    assert options["bank_transfer"] is None
    assert options["flik"]["number"] == "041 123 456"
    response = donations_client.get("/api/donations/upn-qr.svg")
    assert response.status_code == 404
    assert response.json() == {"detail": "donations_off"}


def test_details_without_a_street(donations_client: TestClient) -> None:
    app.dependency_overrides[get_donation_payee] = lambda: Payee(iban=IBAN, name="M", city="C")
    assert donations_client.get("/api/donations").json()["bank_transfer"]["street"] is None


@pytest.mark.parametrize("query", ["", "?amount_cents=1000"])
def test_qr_code_image(donations_client: TestClient, query: str) -> None:
    response = donations_client.get(f"/api/donations/upn-qr.svg{query}")

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/svg+xml"
    assert response.headers["cache-control"] == "public, max-age=3600"
    assert response.text.startswith("<svg")


@pytest.mark.parametrize("amount", ["99", "1000001", "5.5", "abc"])
def test_qr_code_amount_must_be_in_range(donations_client: TestClient, amount: str) -> None:
    response = donations_client.get(f"/api/donations/upn-qr.svg?amount_cents={amount}")
    assert response.status_code == 422
