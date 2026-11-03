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
    dem_dir: str = "/data/dem"

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
