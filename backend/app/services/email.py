"""Sending e-mail over SMTP, and the templates for it.

Every language is a directory in `email_templates/`, so adding one needs no code change.
Names of people and groups are user input: they are reduced to one line before they reach a
template or a header, so they can neither inject headers nor forge lines in the message.
"""

import logging
import smtplib
import ssl
import unicodedata
from email.message import EmailMessage
from email.policy import SMTP as SMTP_POLICY
from email.utils import formatdate, make_msgid
from pathlib import Path
from string import Template
from typing import Annotated, Protocol

from fastapi import Depends

from app.config import Settings, get_settings

logger = logging.getLogger(__name__)

TEMPLATE_DIR = Path(__file__).parent / "email_templates"
DEFAULT_LOCALE = "en"
SMTP_TIMEOUT_S = 10


class EmailError(Exception):
    """The message could not be handed to the mail server."""


class EmailSender(Protocol):
    def send(self, message: EmailMessage) -> None: ...


class SmtpSender:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def send(self, message: EmailMessage) -> None:
        settings = self._settings
        if not settings.smtp_host:
            raise EmailError("SMTP_HOST is not set")
        try:
            with smtplib.SMTP(
                settings.smtp_host, settings.smtp_port, timeout=SMTP_TIMEOUT_S
            ) as smtp:
                if settings.smtp_starttls:
                    smtp.starttls(context=ssl.create_default_context())
                if settings.smtp_user:
                    smtp.login(settings.smtp_user, settings.smtp_password.get_secret_value())
                smtp.send_message(message)
        except (smtplib.SMTPException, OSError) as exc:
            raise EmailError(str(exc)) from exc


def get_email_sender() -> EmailSender:
    return SmtpSender(get_settings())


Mailer = Annotated[EmailSender, Depends(get_email_sender)]


def one_line(value: str) -> str:
    """Collapses all line breaks and white space, and removes control characters."""
    collapsed = " ".join(value.split())
    return "".join(char for char in collapsed if unicodedata.category(char) != "Cc")


def available_locales() -> set[str]:
    return {path.name for path in TEMPLATE_DIR.iterdir() if path.is_dir()}


def pick_locale(*candidates: str | None) -> str:
    """The first candidate with templates, ignoring the region: "sl-SI" means "sl"."""
    available = available_locales()
    for candidate in candidates:
        language = candidate.split("-", 1)[0].lower() if candidate else None
        if language in available:
            return language
    return DEFAULT_LOCALE


def _build(template: str, locale: str, to: str, **values: str) -> EmailMessage:
    text = (TEMPLATE_DIR / locale / f"{template}.txt").read_text(encoding="utf-8")
    subject_line, body = text.split("\n", 1)
    substituted = {key: one_line(value) for key, value in values.items()}
    # Template substitutes in one pass, so a "$" in a name stays literal.
    subject = Template(subject_line.removeprefix("Subject: ")).safe_substitute(substituted)

    message = EmailMessage(policy=SMTP_POLICY)
    message["Subject"] = one_line(subject)
    message["From"] = get_settings().smtp_from
    message["To"] = to
    message["Date"] = formatdate()
    message["Message-ID"] = make_msgid()
    message.set_content(Template(body).safe_substitute(substituted))
    return message


def invitation_email(
    to: str, group: str, inviter: str, link: str, valid_days: int, locale: str
) -> EmailMessage:
    return _build(
        "invitation", locale, to, group=group, inviter=inviter, link=link, days=str(valid_days)
    )


def join_request_email(to: str, group: str, requester: str, link: str, locale: str) -> EmailMessage:
    return _build("join_request", locale, to, group=group, requester=requester, link=link)


def send_best_effort(sender: EmailSender, messages: list[EmailMessage]) -> None:
    """For notifications: a failure is logged and goes no further."""
    for message in messages:
        try:
            sender.send(message)
        except EmailError:
            logger.exception("Could not send a notification e-mail")
