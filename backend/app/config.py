from functools import lru_cache

from pydantic import SecretStr
from pydantic_settings import BaseSettings
from sqlalchemy import URL


class Settings(BaseSettings):
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
    smtp_from: str = "TrailStat <noreply@trailstat.si>"
    smtp_starttls: bool = True
    # The address of the app, for links in e-mails.
    app_url: str = "http://localhost:5173"

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
