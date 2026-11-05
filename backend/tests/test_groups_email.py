"""The e-mail service itself: templates, header injection and talking to the mail server."""

import smtplib
from email import message_from_bytes
from email.policy import default as default_policy
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import GroupVisibility, User
from app.services import email as email_service
from app.services.email import (
    EmailError,
    SmtpSender,
    available_locales,
    invitation_email,
    join_request_email,
    pick_locale,
)
from tests.conftest import AuthHeaders, CreateUser, FakeSender
from tests.groups_helpers import body_of, make_group

EVIL = "Evil\r\nBcc: victim@example.com\r\n\r\nInjected body"


def parsed_headers(raw: bytes) -> Any:
    return message_from_bytes(raw, policy=default_policy)


def test_every_language_has_every_template() -> None:
    template_dir = Path(email_service.TEMPLATE_DIR)
    expected = {path.name for path in (template_dir / "en").iterdir()}
    assert available_locales() >= {"en", "sl"}
    for locale in available_locales():
        assert {path.name for path in (template_dir / locale).iterdir()} == expected
        for path in (template_dir / locale).iterdir():
            first_line = path.read_text(encoding="utf-8").split("\n", 1)[0]
            assert first_line.startswith("Subject: "), path


@pytest.mark.parametrize(
    ("candidates", "expected"),
    [
        (("sl",), "sl"),
        (("sl-SI",), "sl"),
        ((None, "sl"), "sl"),
        (("../../etc", "sl"), "sl"),
        (("de",), "en"),
        ((None, None), "en"),
        ((), "en"),
    ],
)
def test_pick_locale(candidates: tuple[str | None, ...], expected: str) -> None:
    assert pick_locale(*candidates) == expected


def test_slovenian_text_survives_encoding() -> None:
    message = invitation_email(
        to="a@b.si",
        group="Čežek",
        inviter="Špela",
        link="https://x/invitations/t",
        valid_days=7,
        locale="sl",
    )

    parsed = parsed_headers(message.as_bytes())

    assert parsed["Subject"] == "Povabilo v pohodniško skupino na strani TrailStat.si"
    assert "Ime skupine: »Čežek«" in parsed.get_content()
    assert "»Špela«" in parsed.get_content()


@pytest.mark.parametrize("locale", ["en", "sl"])
def test_names_cannot_inject_headers_or_body_lines(locale: str) -> None:
    message = invitation_email(
        to="a@b.si",
        group=EVIL,
        inviter=EVIL,
        link="https://x/invitations/t",
        valid_days=7,
        locale=locale,
    )

    raw = message.as_bytes()
    parsed = parsed_headers(raw)

    assert parsed["Bcc"] is None
    assert "\n" not in parsed["Subject"]
    assert "\r" not in parsed["Subject"]
    assert parsed["To"] == "a@b.si"
    # On one line, as part of the text: it does not start a line of its own.
    assert not any(line.startswith("Bcc:") for line in parsed.get_content().splitlines())
    assert not any(line.startswith("Injected") for line in parsed.get_content().splitlines())


def test_other_line_breaks_and_control_characters_are_removed_too() -> None:
    message = join_request_email(
        to="a@b.si",
        group="A B\x85C\x0bD\x00E",
        requester="X",
        link="https://x/groups/1",
        locale="en",
    )

    subject = parsed_headers(message.as_bytes())["Subject"]

    assert "A B C DE" in subject


def test_dollar_signs_in_names_stay_literal() -> None:
    message = invitation_email(
        to="a@b.si",
        group="$link",
        inviter="${inviter}",
        link="https://x/invitations/secret",
        valid_days=7,
        locale="en",
    )

    assert "secret" not in body_of(message).split("https://x/invitations/secret")[0]
    assert '"$link"' in body_of(message)
    assert "${inviter}" in body_of(message)


@pytest.mark.parametrize("locale", ["en", "sl"])
def test_invitation_subject_has_no_user_controlled_text(locale: str) -> None:
    """The subject is what shows without opening the message, in someone else's inbox."""
    message = invitation_email(
        to="a@b.si",
        group="Claim your prize",
        inviter="Your bank",
        link="https://x/invitations/t",
        valid_days=7,
        locale=locale,
    )

    assert "prize" not in message["Subject"]
    assert "bank" not in message["Subject"]
    assert "TrailStat" in message["Subject"]
    body = body_of(message)
    assert ("Claim your prize" in body) and ("Your bank" in body)
    # Quoted, on lines that say what they are.
    quote = {"en": ('"', '"'), "sl": ("»", "«")}[locale]
    assert f"{quote[0]}Claim your prize{quote[1]}" in body
    assert f"{quote[0]}Your bank{quote[1]}" in body


def test_group_name_with_newlines_through_the_api_cannot_inject_headers(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user(EVIL)
    headers = auth_headers(admin)
    group = client.post(
        "/api/groups", json={"name": "Evil\nBcc: victim@example.com"}, headers=headers
    ).json()

    response = client.post(
        f"/api/groups/{group['id']}/invitations", json={"email": "a@b.si"}, headers=headers
    )

    assert response.status_code == 201
    assert group["name"] == "Evil Bcc: victim@example.com"
    parsed = parsed_headers(outbox.messages[0].as_bytes())
    assert parsed["Bcc"] is None
    assert parsed["To"] == "a@b.si"


def test_display_name_with_newlines_stored_earlier_cannot_inject_headers(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    """The name reaches the database directly here, so only the e-mail layer protects."""
    admin = create_user()
    requester = create_user(EVIL)
    group = make_group(session, name=EVIL, visibility=GroupVisibility.PUBLIC, admins=[admin])

    response = client.post(f"/api/groups/{group.id}/join-requests", headers=auth_headers(requester))

    assert response.status_code == 201
    parsed = parsed_headers(outbox.messages[0].as_bytes())
    assert parsed["Bcc"] is None
    assert parsed["To"] == admin.email


# SMTP


def settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "smtp_host": "mail.example.com",
        "smtp_port": 2525,
        "smtp_starttls": False,
    }
    return Settings(**{**values, **overrides})


def sample_message() -> Any:
    return join_request_email(
        to="a@b.si", group="G", requester="R", link="https://x/groups/1", locale="en"
    )


@pytest.fixture
def smtp(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    factory = MagicMock()
    monkeypatch.setattr(smtplib, "SMTP", factory)
    return factory


def test_sends_through_the_configured_server_without_tls_or_login(smtp: MagicMock) -> None:
    message = sample_message()

    SmtpSender(settings()).send(message)

    assert smtp.call_args.args == ("mail.example.com", 2525)
    connection = smtp.return_value.__enter__.return_value
    connection.starttls.assert_not_called()
    connection.login.assert_not_called()
    connection.send_message.assert_called_once_with(message)


def test_uses_starttls_and_login_when_configured(smtp: MagicMock) -> None:
    SmtpSender(settings(smtp_starttls=True, smtp_user="user", smtp_password=SecretStr("pw"))).send(
        sample_message()
    )

    connection = smtp.return_value.__enter__.return_value
    connection.starttls.assert_called_once()
    connection.login.assert_called_once_with("user", "pw")


def test_no_host_configured_is_an_email_error(smtp: MagicMock) -> None:
    with pytest.raises(EmailError):
        SmtpSender(settings(smtp_host="")).send(sample_message())
    smtp.assert_not_called()


@pytest.mark.parametrize(
    "failure", [OSError("refused"), smtplib.SMTPServerDisconnected("gone"), TimeoutError()]
)
def test_server_failures_become_email_errors(smtp: MagicMock, failure: Exception) -> None:
    smtp.side_effect = failure
    with pytest.raises(EmailError):
        SmtpSender(settings()).send(sample_message())


def test_unreachable_mail_server_gives_email_failed(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    smtp: MagicMock,
) -> None:
    """The real sender, not the fake, all the way to the API's response."""
    smtp.side_effect = OSError("refused")
    admin: User = create_user()
    group = make_group(session, admins=[admin])

    response = client.post(
        f"/api/groups/{group.id}/invitations",
        json={"email": "a@b.si"},
        headers=auth_headers(admin),
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "email_failed"
