import pytest
from fastapi.testclient import TestClient

from tests.conftest import AuthHeaders, CreateUser


def test_read_profile(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    user = create_user(display_name="Marko", country="SI", city="Ljubljana")

    body = client.get("/api/me", headers=auth_headers(user)).json()

    assert body["display_name"] == "Marko"
    assert body["country"] == "SI"
    assert body["city"] == "Ljubljana"
    assert body["avatar_url"] is None
    assert body["locale"] is None


def test_update_profile(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    user = create_user()

    response = client.patch(
        "/api/me",
        headers=auth_headers(user),
        json={"display_name": "  Nick  ", "country": "SI", "city": "Bled", "locale": "sl"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["display_name"] == "Nick"
    assert (body["country"], body["city"], body["locale"]) == ("SI", "Bled", "sl")


def test_partial_update_leaves_other_fields(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    user = create_user(display_name="Keep", city="Bled")

    body = client.patch("/api/me", headers=auth_headers(user), json={"locale": "sl"}).json()

    assert (body["display_name"], body["city"], body["locale"]) == ("Keep", "Bled", "sl")


def test_optional_fields_can_be_cleared(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    user = create_user(country="SI", city="Bled")

    body = client.patch(
        "/api/me", headers=auth_headers(user), json={"country": None, "city": None}
    ).json()

    assert (body["country"], body["city"]) == (None, None)


@pytest.mark.parametrize(
    "payload",
    [
        {"display_name": None},
        {"display_name": "   "},
        {"display_name": "x" * 101},
        {"locale": None},
        {"locale": "slovene"},
        {"country": "Slovenia"},
        {"country": "si"},
        {"city": "x" * 101},
    ],
)
def test_invalid_updates_are_rejected(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    payload: dict[str, object],
) -> None:
    user = create_user(display_name="Keep")

    response = client.patch("/api/me", headers=auth_headers(user), json=payload)

    assert response.status_code == 422
    assert client.get("/api/me", headers=auth_headers(user)).json()["display_name"] == "Keep"


def test_email_and_avatar_cannot_be_changed_through_profile(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    user = create_user(email="keep@example.com")

    body = client.patch(
        "/api/me",
        headers=auth_headers(user),
        json={"email": "evil@example.com", "avatar_url": "https://evil.example/x.png"},
    ).json()

    assert body["email"] == "keep@example.com"
    assert body["avatar_url"] is None
