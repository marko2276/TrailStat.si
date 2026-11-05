"""Creating, editing and listing groups, and what each kind of user may see."""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import GroupMembership, GroupRole, GroupVisibility, JoinRequest, JoinRequestStatus
from tests.conftest import AuthHeaders, CreateUser
from tests.groups_helpers import make_group


def test_creator_becomes_admin(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    user = create_user()
    response = client.post(
        "/api/groups",
        json={"name": "  Hribolazci \n", "description": "Hello", "visibility": "public"},
        headers=auth_headers(user),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Hribolazci"
    assert body["description"] == "Hello"
    assert body["visibility"] == "public"
    assert body["is_member"] is True
    assert body["is_admin"] is True
    assert body["member_count"] == 1
    membership = session.get_one(GroupMembership, (uuid.UUID(body["id"]), user.id))
    assert membership.role == GroupRole.ADMIN


def test_new_group_is_private_unless_stated(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    response = client.post(
        "/api/groups", json={"name": "Quiet"}, headers=auth_headers(create_user())
    )
    assert response.json()["visibility"] == "private"


@pytest.mark.parametrize(
    ("name", "code"),
    [("   ", "group_name_required"), ("x" * 101, "group_name_too_long")],
)
def test_create_rejects_bad_names(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, name: str, code: str
) -> None:
    response = client.post("/api/groups", json={"name": name}, headers=auth_headers(create_user()))
    assert response.status_code == 422
    assert response.json()["detail"] == code


def test_requests_need_sign_in(client: TestClient) -> None:
    assert client.get("/api/groups").status_code == 401
    assert client.post("/api/groups", json={"name": "x"}).status_code == 401


def test_user_can_belong_to_several_groups(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    user = create_user()
    make_group(session, name="B", admins=[user])
    make_group(session, name="a", members=[user])
    make_group(session, name="Not mine", admins=[create_user()])

    body = client.get("/api/groups?scope=mine", headers=auth_headers(user)).json()

    assert [group["name"] for group in body["items"]] == ["a", "B"]
    assert body["total"] == 2
    assert [group["is_admin"] for group in body["items"]] == [False, True]
    assert all(group["member_count"] == 1 for group in body["items"])


def test_public_list_shows_public_groups_with_only_the_name(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    owner, outsider = create_user(), create_user()
    make_group(session, name="Open", visibility=GroupVisibility.PUBLIC, admins=[owner])
    make_group(session, name="Hidden", admins=[owner])

    body = client.get("/api/groups?scope=public", headers=auth_headers(outsider)).json()

    assert body["total"] == 1
    item = body["items"][0]
    assert item["name"] == "Open"
    assert item["description"] is None
    assert item["member_count"] is None
    assert item["is_member"] is False
    assert item["is_admin"] is False


def test_public_list_shows_members_their_details(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    member = create_user()
    make_group(session, name="Open", visibility=GroupVisibility.PUBLIC, members=[member])

    item = client.get("/api/groups?scope=public", headers=auth_headers(member)).json()["items"][0]

    assert item["description"] == "Secret description"
    assert item["member_count"] == 1
    assert item["is_member"] is True


def test_search_matches_the_name_and_treats_wildcards_literally(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    public = GroupVisibility.PUBLIC
    make_group(session, name="Mountain goats", visibility=public)
    make_group(session, name="100% hikers", visibility=public)
    make_group(session, name="Other", visibility=public)
    headers = auth_headers(create_user())

    def search(q: str) -> list[str]:
        response = client.get("/api/groups", params={"scope": "public", "q": q}, headers=headers)
        return [group["name"] for group in response.json()["items"]]

    assert search("MOUNTAIN") == ["Mountain goats"]
    assert search("%") == ["100% hikers"]
    assert search("_") == []


def test_search_ignores_the_case_of_slovenian_letters(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    make_group(session, name="Šentjurski Čuki", visibility=GroupVisibility.PUBLIC)

    body = client.get(
        "/api/groups",
        params={"scope": "public", "q": "šentjurski čuki"},
        headers=auth_headers(create_user()),
    ).json()

    assert body["total"] == 1


def test_search_does_not_reveal_descriptions(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    make_group(session, name="Open", visibility=GroupVisibility.PUBLIC, description="needle")

    response = client.get(
        "/api/groups?scope=public&q=needle", headers=auth_headers(create_user())
    ).json()

    assert response["total"] == 0


def test_lists_are_paginated(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    for name in ("a", "b", "c"):
        make_group(session, name=name, visibility=GroupVisibility.PUBLIC)
    headers = auth_headers(create_user())

    body = client.get("/api/groups?scope=public&limit=1&offset=1", headers=headers).json()

    assert [group["name"] for group in body["items"]] == ["b"]
    assert (body["total"], body["limit"], body["offset"]) == (3, 1, 1)
    assert client.get("/api/groups?limit=201", headers=headers).status_code == 422


def test_private_group_is_invisible_to_outsiders(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    group = make_group(session, admins=[create_user()])
    headers = auth_headers(create_user())
    base = f"/api/groups/{group.id}"

    for path in (
        "",
        "/members",
        "/guests",
        "/invitations",
        "/join-requests",
        "/join-requests/mine",
    ):
        assert client.get(base + path, headers=headers).status_code == 404, path
    assert client.post(f"{base}/join-requests", headers=headers).status_code == 404
    assert client.post(f"{base}/leave", headers=headers).status_code == 404
    assert client.delete(base, headers=headers).status_code == 404
    assert client.patch(base, json={"name": "x"}, headers=headers).status_code == 404
    assert (
        client.post(f"{base}/invitations", json={"email": "a@b.si"}, headers=headers).status_code
        == 404
    )
    assert client.post(f"{base}/guests", json={"nickname": "x"}, headers=headers).status_code == 404
    assert client.get("/api/groups?scope=public", headers=headers).json()["total"] == 0


def test_private_group_is_visible_to_a_member(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    member = create_user()
    group = make_group(session, members=[member])

    body = client.get(f"/api/groups/{group.id}", headers=auth_headers(member)).json()

    assert body["description"] == "Secret description"
    assert body["member_count"] == 1
    assert body["is_member"] is True
    assert body["is_admin"] is False


def test_nothing_leaks_to_a_non_member_of_a_public_group(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    secret_user = create_user("Secret Person")
    group = make_group(session, visibility=GroupVisibility.PUBLIC, admins=[secret_user])
    headers = auth_headers(create_user())
    base = f"/api/groups/{group.id}"

    response = client.get(base, headers=headers)

    assert response.status_code == 200
    assert response.json() == {
        "id": str(group.id),
        "name": "Hikers",
        "description": None,
        "visibility": "public",
        "is_member": False,
        "is_admin": False,
        "member_count": None,
    }
    for path in ("/members", "/guests", "/invitations", "/join-requests"):
        forbidden = client.get(base + path, headers=headers)
        assert forbidden.status_code == 403, path
        assert "Secret" not in forbidden.text
    assert client.post(f"{base}/guests", json={"nickname": "x"}, headers=headers).status_code == 403


def test_admin_edits_the_group(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])

    response = client.patch(
        f"/api/groups/{group.id}",
        json={"name": "New", "description": "  ", "visibility": "public"},
        headers=auth_headers(admin),
    )

    assert response.status_code == 200
    assert response.json()["name"] == "New"
    assert response.json()["description"] is None
    assert response.json()["visibility"] == "public"


def test_edit_changes_only_fields_in_the_request(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])

    body = client.patch(
        f"/api/groups/{group.id}", json={"name": "New"}, headers=auth_headers(admin)
    ).json()

    assert body["description"] == "Secret description"
    assert body["visibility"] == "private"


@pytest.mark.parametrize(
    ("change", "code"),
    [({"name": None}, "group_name_required"), ({"visibility": None}, "visibility_required")],
)
def test_edit_cannot_clear_required_fields(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    change: dict[str, None],
    code: str,
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])

    response = client.patch(f"/api/groups/{group.id}", json=change, headers=auth_headers(admin))

    assert response.status_code == 422
    assert response.json()["detail"] == code


def test_plain_member_cannot_edit(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    member = create_user()
    group = make_group(session, members=[member])

    response = client.patch(
        f"/api/groups/{group.id}", json={"name": "New"}, headers=auth_headers(member)
    )

    assert response.status_code == 403
    session.expire_all()
    assert group.name == "Hikers"


def test_outsider_cannot_edit_a_public_group(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    group = make_group(session, visibility=GroupVisibility.PUBLIC)

    response = client.patch(
        f"/api/groups/{group.id}", json={"name": "New"}, headers=auth_headers(create_user())
    )

    assert response.status_code == 403


def test_making_a_group_private_closes_pending_join_requests(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin, requester = create_user(), create_user()
    group = make_group(session, visibility=GroupVisibility.PUBLIC, admins=[admin])
    request = JoinRequest(group_id=group.id, user_id=requester.id, status=JoinRequestStatus.PENDING)
    session.add(request)
    session.commit()

    client.patch(
        f"/api/groups/{group.id}", json={"visibility": "private"}, headers=auth_headers(admin)
    )

    session.expire_all()
    assert request.status == JoinRequestStatus.REJECTED


def test_unknown_group_is_404(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    response = client.get(f"/api/groups/{uuid.uuid4()}", headers=auth_headers(create_user()))
    assert response.status_code == 404


def test_nul_characters_in_names_are_removed_not_a_server_error(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    headers = auth_headers(create_user())

    group = client.post("/api/groups", json={"name": "A\x00B"}, headers=headers)
    assert (group.status_code, group.json()["name"]) == (201, "AB")
    guest = client.post(
        f"/api/groups/{group.json()['id']}/guests", json={"nickname": "C\x00D"}, headers=headers
    )
    assert (guest.status_code, guest.json()["nickname"]) == (201, "CD")
