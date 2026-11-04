"""Test infrastructure.

Tests run against a real PostgreSQL + PostGIS database named `<db>_test`, built from the
migrations once per run. Every test runs in a transaction that is rolled back, so tests can
call commit() freely and stay isolated.

Authentication uses real signed tokens with a test RSA key; only fetching Hanko's public
keys is replaced.
"""

import time
import uuid
from collections.abc import Callable, Iterator
from email.message import EmailMessage
from pathlib import Path
from typing import Any

import jwt
import pytest
from alembic import command
from alembic.config import Config
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine, create_engine, text
from sqlalchemy.orm import Session

from app import auth
from app.config import get_settings
from app.db import get_session
from app.main import app
from app.models import User
from app.services.email import EmailError, get_email_sender

BACKEND_DIR = Path(__file__).resolve().parent.parent
KEY_ID = "test-key"


def alembic_config(connection: Connection) -> Config:
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    config.attributes["connection"] = connection
    return config


@pytest.fixture(scope="session")
def test_engine() -> Iterator[Engine]:
    url = get_settings().database_url
    test_db = f"{url.database}_test"
    with create_engine(url, isolation_level="AUTOCOMMIT").connect() as admin:
        admin.execute(text(f'DROP DATABASE IF EXISTS "{test_db}" WITH (FORCE)'))
        admin.execute(text(f'CREATE DATABASE "{test_db}"'))

    engine = create_engine(url.set(database=test_db))
    with engine.connect() as connection:
        command.upgrade(alembic_config(connection), "head")
        connection.commit()
    yield engine
    engine.dispose()


@pytest.fixture
def session(test_engine: Engine) -> Iterator[Session]:
    with test_engine.connect() as connection:
        transaction = connection.begin()
        db_session = Session(bind=connection, join_transaction_mode="create_savepoint")
        yield db_session
        db_session.close()
        transaction.rollback()


@pytest.fixture
def client(session: Session) -> Iterator[TestClient]:
    app.dependency_overrides[get_session] = lambda: session
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture(scope="session")
def rsa_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


class _FakeJwkClient:
    def __init__(self, key: rsa.RSAPublicKey) -> None:
        self._key = key

    def get_signing_key_from_jwt(self, token: str) -> Any:
        header = jwt.get_unverified_header(token)  # malformed tokens raise, like the real one
        if header.get("kid") != KEY_ID:
            raise jwt.PyJWKClientError("Unknown key")
        return type("Key", (), {"key": self._key})()


@pytest.fixture(autouse=True)
def fake_jwks(monkeypatch: pytest.MonkeyPatch, rsa_key: rsa.RSAPrivateKey) -> None:
    monkeypatch.setattr(auth, "get_jwk_client", lambda: _FakeJwkClient(rsa_key.public_key()))


MakeToken = Callable[..., str]


@pytest.fixture
def make_token(rsa_key: rsa.RSAPrivateKey) -> MakeToken:
    def _make(
        subject: str = "hanko-user",
        email: str | None = "user@example.com",
        expires_in: int = 3600,
        key_id: str = KEY_ID,
        **extra_claims: Any,
    ) -> str:
        claims: dict[str, Any] = {
            "sub": subject,
            "exp": int(time.time()) + expires_in,
            **extra_claims,
        }
        if email is not None:
            claims["email"] = {"address": email, "is_primary": True, "is_verified": True}
        return jwt.encode(claims, rsa_key, algorithm="RS256", headers={"kid": key_id})

    return _make


CreateUser = Callable[..., User]
AuthHeaders = Callable[[User], dict[str, str]]


@pytest.fixture
def create_user(session: Session) -> CreateUser:
    """Create a user directly in the database."""

    def _create(display_name: str = "Test User", email: str | None = None, **fields: Any) -> User:
        unique = uuid.uuid4().hex
        user = User(
            auth_subject=f"hanko-{unique}",
            email=email or f"{unique}@example.com",
            display_name=display_name,
            **fields,
        )
        session.add(user)
        session.commit()
        return user

    return _create


@pytest.fixture
def auth_headers(make_token: MakeToken) -> AuthHeaders:
    """Request headers that sign in as the given user."""

    def _headers(user: User) -> dict[str, str]:
        token = make_token(subject=user.auth_subject, email=user.email)
        return {"Authorization": f"Bearer {token}"}

    return _headers


class FakeSender:
    """Records messages instead of sending them. Set `fail` to simulate a mail server failure."""

    def __init__(self) -> None:
        self.messages: list[EmailMessage] = []
        self.fail = False

    def send(self, message: EmailMessage) -> None:
        if self.fail:
            raise EmailError("simulated failure")
        self.messages.append(message)


@pytest.fixture
def outbox() -> Iterator[FakeSender]:
    sender = FakeSender()
    app.dependency_overrides[get_email_sender] = lambda: sender
    yield sender
    app.dependency_overrides.pop(get_email_sender, None)
