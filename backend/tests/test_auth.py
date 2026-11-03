from unittest.mock import MagicMock

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import auth
from app.config import get_settings
from app.models import User
from tests.conftest import KEY_ID, MakeToken

# The fake_jwks fixture replaces this for every test; keep the real one for the test using it.
REAL_GET_JWK_CLIENT = auth.get_jwk_client


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_no_token_is_rejected(client: TestClient) -> None:
    response = client.get("/api/me")

    assert response.status_code == 401
    assert response.json() == {"detail": "not_authenticated"}
    assert response.headers["www-authenticate"] == "Bearer"


def test_first_login_creates_user(
    client: TestClient, make_token: MakeToken, session: Session
) -> None:
    response = client.get("/api/me", headers=bearer(make_token("sub-1", "marko@example.com")))

    assert response.status_code == 200
    assert response.json()["email"] == "marko@example.com"
    assert response.json()["display_name"] == "marko"
    assert session.scalar(select(User).where(User.auth_subject == "sub-1")) is not None


def test_second_login_reuses_user(
    client: TestClient, make_token: MakeToken, session: Session
) -> None:
    first = client.get("/api/me", headers=bearer(make_token("sub-2", "a@example.com")))
    second = client.get("/api/me", headers=bearer(make_token("sub-2", "a@example.com")))

    assert first.json()["id"] == second.json()["id"]
    count = session.scalar(
        select(func.count()).select_from(User).where(User.auth_subject == "sub-2")
    )
    assert count == 1


def test_changed_email_in_hanko_is_synced(client: TestClient, make_token: MakeToken) -> None:
    client.get("/api/me", headers=bearer(make_token("sub-3", "old@example.com")))
    response = client.get("/api/me", headers=bearer(make_token("sub-3", "new@example.com")))

    assert response.json()["email"] == "new@example.com"


def test_expired_token_is_rejected(client: TestClient, make_token: MakeToken) -> None:
    response = client.get("/api/me", headers=bearer(make_token(expires_in=-60)))

    assert response.status_code == 401
    assert response.json() == {"detail": "invalid_token"}


def test_token_signed_with_other_key_is_rejected(client: TestClient) -> None:
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    token = jwt.encode(
        {"sub": "attacker", "exp": 9999999999}, other_key, "RS256", headers={"kid": KEY_ID}
    )

    assert client.get("/api/me", headers=bearer(token)).status_code == 401


def test_unsigned_token_is_rejected(client: TestClient) -> None:
    token = jwt.encode({"sub": "attacker", "exp": 9999999999}, "", "none", headers={"kid": KEY_ID})

    assert client.get("/api/me", headers=bearer(token)).status_code == 401


def test_symmetric_token_is_rejected(client: TestClient) -> None:
    token = jwt.encode(
        {"sub": "attacker", "exp": 9999999999}, "x" * 64, "HS256", headers={"kid": KEY_ID}
    )

    assert client.get("/api/me", headers=bearer(token)).status_code == 401


def test_unknown_key_id_is_rejected(client: TestClient, make_token: MakeToken) -> None:
    response = client.get("/api/me", headers=bearer(make_token(key_id="other")))

    assert response.status_code == 401


def test_garbage_token_is_rejected(client: TestClient) -> None:
    assert client.get("/api/me", headers=bearer("not-a-jwt")).status_code == 401


def test_token_without_subject_is_rejected(client: TestClient, rsa_key: rsa.RSAPrivateKey) -> None:
    token = jwt.encode({"exp": 9999999999}, rsa_key, "RS256", headers={"kid": KEY_ID})

    assert client.get("/api/me", headers=bearer(token)).status_code == 401


def test_audience_is_enforced_when_configured(
    client: TestClient, make_token: MakeToken, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(get_settings(), "hanko_audience", "trailstat.si")

    wrong = client.get("/api/me", headers=bearer(make_token("sub-a", aud=["other.example"])))
    right = client.get("/api/me", headers=bearer(make_token("sub-a", aud=["trailstat.si"])))

    assert wrong.status_code == 401
    assert right.status_code == 200


def test_key_server_unreachable_gives_503(
    client: TestClient, make_token: MakeToken, monkeypatch: pytest.MonkeyPatch
) -> None:
    failing = MagicMock()
    failing.get_signing_key_from_jwt.side_effect = jwt.PyJWKClientConnectionError("down")
    monkeypatch.setattr(auth, "get_jwk_client", lambda: failing)

    response = client.get("/api/me", headers=bearer(make_token()))

    assert response.status_code == 503
    assert response.json() == {"detail": "auth_unavailable"}


def test_email_is_fetched_from_hanko_when_not_in_token(
    client: TestClient, make_token: MakeToken, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(get_settings(), "hanko_api_url", "https://hanko.test")
    get = MagicMock(return_value=MagicMock(json=lambda: {"email": "fetched@example.com"}))
    monkeypatch.setattr(httpx, "get", get)

    response = client.get("/api/me", headers=bearer(make_token("sub-4", email=None)))

    assert response.status_code == 200
    assert response.json()["email"] == "fetched@example.com"
    assert get.call_args.args[0] == "https://hanko.test/users/sub-4"


def test_hanko_failure_while_fetching_email_gives_503_and_creates_nothing(
    client: TestClient, make_token: MakeToken, monkeypatch: pytest.MonkeyPatch, session: Session
) -> None:
    monkeypatch.setattr(get_settings(), "hanko_api_url", "https://hanko.test")
    monkeypatch.setattr(httpx, "get", MagicMock(side_effect=httpx.ConnectError("down")))

    response = client.get("/api/me", headers=bearer(make_token("sub-5", email=None)))

    assert response.status_code == 503
    assert session.scalar(select(User).where(User.auth_subject == "sub-5")) is None


def test_unconfigured_hanko_fails_closed(
    client: TestClient, make_token: MakeToken, monkeypatch: pytest.MonkeyPatch
) -> None:
    REAL_GET_JWK_CLIENT.cache_clear()
    monkeypatch.setattr(auth, "get_jwk_client", REAL_GET_JWK_CLIENT)
    monkeypatch.setattr(get_settings(), "hanko_api_url", "")

    response = client.get("/api/me", headers=bearer(make_token()))

    assert response.status_code == 503
    assert response.json() == {"detail": "auth_not_configured"}
