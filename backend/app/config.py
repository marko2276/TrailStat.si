from functools import lru_cache
from typing import Literal
from urllib.parse import urlsplit

from pydantic import SecretStr, model_validator
from pydantic_settings import BaseSettings
from sqlalchemy import URL

from app.services.flik import normalise_flik_number
from app.services.upn_qr import Payee, normalise_iban


class Settings(BaseSettings):
    # Production refuses to start without what it needs: see `production_problems`.
    environment: Literal["development", "production"] = "development"

    postgres_host: str = "db"
    postgres_port: int = 5432
    postgres_user: str = "trailstat"
    postgres_password: SecretStr = SecretStr("")
    postgres_db: str = "trailstat"

    hanko_api_url: str = ""
    # When set, tokens must carry this audience. In production: the app's domain.
    hanko_audience: str = ""
    dem_dir: str = "/data/dem"
    overpass_url: str = "https://overpass-api.de/api/interpreter"

    # Without an SMTP host, sending fails and invitations report `email_failed`.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: SecretStr = SecretStr("")
    smtp_from: str = '"TrailStat.si" <noreply@trailstat.si>'
    smtp_starttls: bool = True
    # The address of the app, for links in e-mails.
    app_url: str = "http://localhost:5173"

    # Donations by bank transfer, with a UPN QR code. Off without an IBAN. The name, street and
    # city are the account holder's, as on a payment order; the street may stay empty.
    donation_iban: str = ""
    donation_name: str = ""
    donation_street: str = ""
    donation_city: str = ""
    donation_purpose: str = "Donacija TrailStat.si"
    # Donations with Flik, to this phone number. Off while empty. Shown publicly.
    donation_flik_number: str = ""

    # Hanko user IDs (comma-separated) that may open the admin page. Empty: nobody.
    admin_user_ids: str = ""
    # Shown on the admin page, e.g. the git commit the server was built from.
    app_version: str = "dev"

    @property
    def admin_subjects(self) -> frozenset[str]:
        return frozenset(part.strip() for part in self.admin_user_ids.split(",") if part.strip())

    @model_validator(mode="after")
    def _check_donations(self) -> "Settings":
        # In every environment: a wrong IBAN would send people's money nowhere, or elsewhere.
        try:
            _ = self.donation_payee
            _ = self.donation_flik_number_display
        except ValueError as exc:
            raise ValueError(f"DONATION_* settings: {exc}") from exc
        return self

    @property
    def donation_payee(self) -> Payee | None:
        if not self.donation_iban.strip():
            return None
        return Payee(
            iban=normalise_iban(self.donation_iban),
            name=self.donation_name.strip(),
            street=self.donation_street.strip(),
            city=self.donation_city.strip(),
            purpose=self.donation_purpose.strip(),
        )

    @property
    def donation_flik_number_display(self) -> str | None:
        if not self.donation_flik_number.strip():
            return None
        return normalise_flik_number(self.donation_flik_number)

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    def production_problems(self) -> list[str]:
        """What is wrong for production. Without these the app would seem to work: without an
        audience it accepts tokens for other sites, and without SMTP it sends no notifications."""
        if not self.is_production:
            return []
        problems = [
            f"{name} must be set"
            for name, value in (
                ("HANKO_API_URL", self.hanko_api_url),
                ("HANKO_AUDIENCE", self.hanko_audience),
                ("SMTP_HOST", self.smtp_host),
            )
            if not value.strip()
        ]
        app_url = urlsplit(self.app_url.strip())
        if app_url.scheme != "https" or not app_url.netloc:
            problems.append("APP_URL must be an https:// address")
        return problems

    @property
    def database_url(self) -> URL:
        # URL.create escapes special characters in the password.
        return URL.create(
            "postgresql+psycopg",
            username=self.postgres_user,
            password=self.postgres_password.get_secret_value(),
            host=self.postgres_host,
            port=self.postgres_port,
            database=self.postgres_db,
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
