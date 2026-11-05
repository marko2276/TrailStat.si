"""What ENVIRONMENT=production demands, and what it turns off."""

import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import Settings
from app.main import create_app

BACKEND_DIR = Path(__file__).resolve().parent.parent
COMPLETE = {
    "hanko_api_url": "https://hanko.trailstat.si",
    "hanko_audience": "trailstat.si",
    "smtp_host": "smtp.trailstat.si",
    "app_url": "https://trailstat.si",
}


def production(**overrides: Any) -> Settings:
    return Settings(environment="production", **{**COMPLETE, **overrides})


def test_development_is_the_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    assert Settings().environment == "development"


def test_an_unknown_environment_is_refused() -> None:
    """Otherwise a typo would silently turn all the checks off."""
    with pytest.raises(ValidationError):
        Settings(environment="prod")  # type: ignore[arg-type]


def test_development_checks_nothing_and_has_the_docs() -> None:
    settings = Settings(
        environment="development", hanko_api_url="", hanko_audience="", smtp_host="", app_url=""
    )

    client = TestClient(create_app(settings))

    assert client.get("/api/docs").status_code == 200
    assert client.get("/api/openapi.json").status_code == 200


def test_production_turns_the_docs_off_and_still_serves_the_api() -> None:
    client = TestClient(create_app(production()))

    assert client.get("/api/docs").status_code == 404
    assert client.get("/api/openapi.json").status_code == 404
    assert client.get("/api/docs/oauth2-redirect").status_code == 404
    assert client.get("/api/health").status_code == 200


@pytest.mark.parametrize(
    ("field", "value", "named"),
    [
        ("hanko_api_url", "", "HANKO_API_URL"),
        ("hanko_api_url", "   ", "HANKO_API_URL"),
        ("hanko_audience", "", "HANKO_AUDIENCE"),
        ("smtp_host", "", "SMTP_HOST"),
        ("app_url", "", "APP_URL"),
        ("app_url", "http://trailstat.si", "APP_URL"),
        ("app_url", "trailstat.si", "APP_URL"),
        ("app_url", "https://", "APP_URL"),
    ],
)
def test_production_refuses_to_start_without_its_settings(
    field: str, value: str, named: str
) -> None:
    with pytest.raises(RuntimeError, match=named):
        create_app(production(**{field: value}))


def test_the_process_itself_refuses_and_names_everything_missing() -> None:
    env = {
        **os.environ,
        "ENVIRONMENT": "production",
        "HANKO_API_URL": "",
        "HANKO_AUDIENCE": "",
        "SMTP_HOST": "",
        "APP_URL": "http://localhost:8080",
    }

    result = subprocess.run(
        [sys.executable, "-c", "import app.main"],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    assert result.returncode != 0
    for name in ("HANKO_API_URL", "HANKO_AUDIENCE", "SMTP_HOST", "APP_URL"):
        assert name in result.stderr
