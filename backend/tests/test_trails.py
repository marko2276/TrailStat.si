"""Trail endpoints: manual trails, visibility, permissions, name scopes, archiving and listing."""

import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import (
    Group,
    GroupMembership,
    GroupRole,
    GroupVisibility,
    Trail,
    TrailSource,
    TrailVisibility,
    User,
)
from tests.conftest import AuthHeaders, CreateUser

MakeGroup = Callable[..., Group]
PostTrail = Callable[..., dict[str, Any]]


@pytest.fixture
def make_group(session: Session) -> MakeGroup:
    def _make(
        *,
        admins: tuple[User, ...] = (),
        members: tuple[User, ...] = (),
        visibility: GroupVisibility = GroupVisibility.PRIVATE,
        name: str = "Hikers",
    ) -> Group:
        group = Group(name=name, visibility=visibility)
        session.add(group)
        session.flush()
        for user in admins:
            session.add(GroupMembership(group_id=group.id, user_id=user.id, role=GroupRole.ADMIN))
        for user in members:
            session.add(GroupMembership(group_id=group.id, user_id=user.id, role=GroupRole.MEMBER))
        session.commit()
        return group

    return _make


def trail_body(**fields: Any) -> dict[str, Any]:
    return {
        "name": "Šmarna gora",
        "distance_m": 4200,
        "elevation_gain_m": 350,
        "visibility": "private",
        **fields,
    }


@pytest.fixture
def post_trail(client: TestClient, auth_headers: AuthHeaders) -> PostTrail:
    """Creates a trail through the API and returns the response body."""

    def _post(user: User, **fields: Any) -> dict[str, Any]:
        response = client.post("/api/trails", headers=auth_headers(user), json=trail_body(**fields))
        assert response.status_code == 201, response.text
        body: dict[str, Any] = response.json()
        return body

    return _post


# Creating


def test_create_manual_trail_returns_full_detail(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    user = create_user(display_name="Marko")

    response = client.post(
        "/api/trails",
        headers=auth_headers(user),
        json=trail_body(
            name="  Pot na Krim  ",
            description="  Lepa pot  ",
            highest_point_m=1107,
            visibility="public",
        ),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Pot na Krim"
    assert body["description"] == "Lepa pot"
    assert (body["distance_m"], body["elevation_gain_m"]) == (4200, 350)
    assert body["highest_point_m"] == 1107
    assert body["source"] == "manual"
    assert body["visibility"] == "public"
    assert body["owner_user_id"] == str(user.id)
    assert body["owner_name"] == "Marko"
    assert body["can_edit"] is True
    assert body["archived"] is False
    # Shown without a map
    assert body["geometry"] is None
    assert body["elevation_profile"] is None
    assert body["osm_relation_id"] is None


def test_create_trail_cannot_choose_owner_or_source(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    user, other = create_user(), create_user()

    body = client.post(
        "/api/trails",
        headers=auth_headers(user),
        json=trail_body(owner_user_id=str(other.id), source="osm", osm_relation_id=1),
    ).json()

    assert body["owner_user_id"] == str(user.id)
    assert body["source"] == "manual"
    assert body["osm_relation_id"] is None


@pytest.mark.parametrize(
    "fields",
    [
        {"name": ""},
        {"name": "    "},
        {"name": "x" * 201},
        {"name": "with\x00nul"},
        {"name": "line\nbreak"},
        {"name": None},
        {"distance_m": -1},
        {"distance_m": 0},
        {"distance_m": 10_000_001},
        {"distance_m": 2**40},
        {"distance_m": 1.5},
        {"distance_m": "far"},
        {"distance_m": None},
        {"elevation_gain_m": -1},
        {"elevation_gain_m": 1_000_001},
        {"elevation_gain_m": None},
        {"highest_point_m": 9001},
        {"highest_point_m": -501},
        {"description": "x" * 5001},
        {"description": "nul\x00byte"},
        {"visibility": "secret"},
        {"visibility": "group", "group_id": "not-a-uuid"},
    ],
)
def test_create_trail_rejects_invalid_input(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, fields: dict[str, Any]
) -> None:
    response = client.post(
        "/api/trails", headers=auth_headers(create_user()), json=trail_body(**fields)
    )

    assert response.status_code == 422


def test_longest_allowed_values_are_accepted(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    response = client.post(
        "/api/trails",
        headers=auth_headers(create_user()),
        json=trail_body(
            name="x" * 200,
            description="y\nz" * 1666,
            distance_m=10_000_000,
            elevation_gain_m=1_000_000,
        ),
    )

    assert response.status_code == 201


def test_empty_description_is_stored_as_none(
    create_user: CreateUser, post_trail: PostTrail
) -> None:
    assert post_trail(create_user(), description="   ")["description"] is None


def test_requires_sign_in(client: TestClient) -> None:
    assert client.get("/api/trails").status_code == 401
    assert client.post("/api/trails", json=trail_body()).status_code == 401
    assert client.get(f"/api/trails/{uuid.uuid4()}").status_code == 401
    assert client.patch(f"/api/trails/{uuid.uuid4()}", json={}).status_code == 401
    assert client.post(f"/api/trails/{uuid.uuid4()}/archive").status_code == 401
    assert client.post(f"/api/trails/{uuid.uuid4()}/unarchive").status_code == 401


# Group sharing on create


def test_member_can_share_with_their_group(
    create_user: CreateUser, make_group: MakeGroup, post_trail: PostTrail
) -> None:
    member = create_user()
    group = make_group(members=(member,), name="Planinci")

    body = post_trail(member, visibility="group", group_id=str(group.id))

    assert body["visibility"] == "group"
    assert body["group_id"] == str(group.id)
    assert body["group_name"] == "Planinci"
    # Group visibility only shares the trail: the creator stays its owner.
    assert body["owner_user_id"] == str(member.id)


def test_group_visibility_requires_a_group(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    response = client.post(
        "/api/trails",
        headers=auth_headers(create_user()),
        json=trail_body(visibility="group"),
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "group_required"


@pytest.mark.parametrize("visibility", ["public", "private"])
def test_group_id_is_rejected_for_other_visibilities(
    client: TestClient,
    create_user: CreateUser,
    make_group: MakeGroup,
    auth_headers: AuthHeaders,
    visibility: str,
) -> None:
    member = create_user()
    group = make_group(members=(member,))

    response = client.post(
        "/api/trails",
        headers=auth_headers(member),
        json=trail_body(visibility=visibility, group_id=str(group.id)),
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "group_not_allowed"


def test_cannot_share_with_a_private_group_you_are_not_in(
    client: TestClient, create_user: CreateUser, make_group: MakeGroup, auth_headers: AuthHeaders
) -> None:
    group = make_group(members=(create_user(),))

    response = client.post(
        "/api/trails",
        headers=auth_headers(create_user()),
        json=trail_body(visibility="group", group_id=str(group.id)),
    )

    # Its existence must not leak.
    assert response.status_code == 404


def test_cannot_share_with_a_public_group_you_are_not_in(
    client: TestClient, create_user: CreateUser, make_group: MakeGroup, auth_headers: AuthHeaders
) -> None:
    group = make_group(visibility=GroupVisibility.PUBLIC)

    response = client.post(
        "/api/trails",
        headers=auth_headers(create_user()),
        json=trail_body(visibility="group", group_id=str(group.id)),
    )

    assert response.status_code == 403


def test_cannot_share_with_a_group_that_does_not_exist(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    response = client.post(
        "/api/trails",
        headers=auth_headers(create_user()),
        json=trail_body(visibility="group", group_id=str(uuid.uuid4())),
    )

    assert response.status_code == 404


# Name scopes


def assert_name_taken(response: Any) -> None:
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == "trail_name_taken"


def test_public_names_are_unique_across_users(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, post_trail: PostTrail
) -> None:
    post_trail(create_user(), name="Krim", visibility="public")

    assert_name_taken(
        client.post(
            "/api/trails",
            headers=auth_headers(create_user()),
            json=trail_body(name="Krim", visibility="public"),
        )
    )


@pytest.mark.parametrize(
    ("first", "second"),
    [
        ("Krim", "KRIM"),
        ("Krim", "  krim "),
        ("Šmarna Gora", "šmarna gora"),
        ("ČRNA PST", "črna pst"),
    ],
)
def test_names_compare_case_insensitively(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
    first: str,
    second: str,
) -> None:
    user = create_user()
    post_trail(user, name=first)

    assert_name_taken(
        client.post("/api/trails", headers=auth_headers(user), json=trail_body(name=second))
    )


def test_private_names_are_unique_per_user_only(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, post_trail: PostTrail
) -> None:
    user, other = create_user(), create_user()
    post_trail(user, name="Krim")

    assert_name_taken(
        client.post("/api/trails", headers=auth_headers(user), json=trail_body(name="Krim"))
    )
    assert post_trail(other, name="Krim")["name"] == "Krim"


def test_group_names_are_unique_per_group_only(
    client: TestClient,
    create_user: CreateUser,
    make_group: MakeGroup,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
) -> None:
    first, second = create_user(), create_user()
    group = make_group(members=(first, second))
    other_group = make_group(members=(first,))
    post_trail(first, name="Krim", visibility="group", group_id=str(group.id))

    assert_name_taken(
        client.post(
            "/api/trails",
            headers=auth_headers(second),
            json=trail_body(name="Krim", visibility="group", group_id=str(group.id)),
        )
    )
    post_trail(first, name="Krim", visibility="group", group_id=str(other_group.id))


def test_same_name_is_allowed_across_scopes(
    create_user: CreateUser, make_group: MakeGroup, post_trail: PostTrail
) -> None:
    user = create_user()
    group = make_group(members=(user,))

    post_trail(user, name="Krim", visibility="public")
    post_trail(user, name="Krim", visibility="private")
    post_trail(user, name="Krim", visibility="group", group_id=str(group.id))


def test_failed_create_leaves_no_trail_behind(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, post_trail: PostTrail
) -> None:
    user = create_user()
    post_trail(user, name="Krim")

    client.post("/api/trails", headers=auth_headers(user), json=trail_body(name="krim"))

    assert client.get("/api/trails", headers=auth_headers(user)).json()["total"] == 1


# Who sees what


def test_public_trail_is_visible_to_every_user(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, post_trail: PostTrail
) -> None:
    trail = post_trail(create_user(), visibility="public")

    response = client.get(f"/api/trails/{trail['id']}", headers=auth_headers(create_user()))

    assert response.status_code == 200
    assert response.json()["can_edit"] is False


def test_private_trail_is_hidden_as_not_found_from_others(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, post_trail: PostTrail
) -> None:
    owner, other = create_user(), create_user()
    trail = post_trail(owner, visibility="private")
    url = f"/api/trails/{trail['id']}"

    assert client.get(url, headers=auth_headers(owner)).status_code == 200
    assert client.get(url, headers=auth_headers(other)).status_code == 404
    assert client.patch(url, headers=auth_headers(other), json={"name": "x"}).status_code == 404
    assert client.post(f"{url}/archive", headers=auth_headers(other)).status_code == 404
    assert client.post(f"{url}/unarchive", headers=auth_headers(other)).status_code == 404


def test_group_trail_is_visible_to_members_only(
    client: TestClient,
    create_user: CreateUser,
    make_group: MakeGroup,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
) -> None:
    owner, member, outsider = create_user(), create_user(), create_user()
    group = make_group(members=(owner, member))
    trail = post_trail(owner, visibility="group", group_id=str(group.id))
    url = f"/api/trails/{trail['id']}"

    assert client.get(url, headers=auth_headers(member)).status_code == 200
    assert client.get(url, headers=auth_headers(outsider)).status_code == 404
    assert client.patch(url, headers=auth_headers(outsider), json={"name": "x"}).status_code == 404


def test_unknown_or_malformed_trail_id(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    headers = auth_headers(create_user())

    assert client.get(f"/api/trails/{uuid.uuid4()}", headers=headers).status_code == 404
    assert client.get("/api/trails/not-a-uuid", headers=headers).status_code == 422


# Who may edit


def test_creator_can_edit_their_public_trail(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, post_trail: PostTrail
) -> None:
    owner = create_user()
    trail = post_trail(owner, visibility="public")

    response = client.patch(
        f"/api/trails/{trail['id']}",
        headers=auth_headers(owner),
        json={"name": "New name", "distance_m": 5000, "elevation_gain_m": 10},
    )

    assert response.status_code == 200
    body = response.json()
    assert (body["name"], body["distance_m"], body["elevation_gain_m"]) == ("New name", 5000, 10)


def test_others_cannot_edit_or_archive_a_public_trail(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, post_trail: PostTrail
) -> None:
    trail = post_trail(create_user(), visibility="public", name="Original")
    other = auth_headers(create_user())
    url = f"/api/trails/{trail['id']}"

    assert client.patch(url, headers=other, json={"name": "Stolen"}).status_code == 403
    assert client.post(f"{url}/archive", headers=other).status_code == 403
    assert client.post(f"{url}/unarchive", headers=other).status_code == 403
    assert client.get(url, headers=other).json()["name"] == "Original"
    assert client.get(url, headers=other).json()["archived"] is False


def test_group_admin_can_edit_a_members_trail_but_a_plain_member_cannot(
    client: TestClient,
    create_user: CreateUser,
    make_group: MakeGroup,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
) -> None:
    owner, admin, member = create_user(), create_user(), create_user()
    group = make_group(admins=(admin,), members=(owner, member))
    trail = post_trail(owner, visibility="group", group_id=str(group.id))
    url = f"/api/trails/{trail['id']}"

    assert client.get(url, headers=auth_headers(owner)).json()["can_edit"] is True
    assert client.get(url, headers=auth_headers(admin)).json()["can_edit"] is True
    assert client.get(url, headers=auth_headers(member)).json()["can_edit"] is False

    assert (
        client.patch(url, headers=auth_headers(member), json={"name": "By member"}).status_code
        == 403
    )
    assert client.post(f"{url}/archive", headers=auth_headers(member)).status_code == 403

    body = client.patch(url, headers=auth_headers(admin), json={"name": "By admin"}).json()
    assert body["name"] == "By admin"
    # Editing does not hand over ownership.
    assert body["owner_user_id"] == str(owner.id)
    assert client.post(f"{url}/archive", headers=auth_headers(admin)).status_code == 200
    assert client.post(f"{url}/unarchive", headers=auth_headers(admin)).status_code == 200


def test_admin_of_another_group_cannot_edit(
    client: TestClient,
    create_user: CreateUser,
    make_group: MakeGroup,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
) -> None:
    owner, foreign_admin = create_user(), create_user()
    group = make_group(members=(owner,))
    make_group(admins=(foreign_admin,))
    trail = post_trail(owner, visibility="group", group_id=str(group.id))

    response = client.patch(
        f"/api/trails/{trail['id']}", headers=auth_headers(foreign_admin), json={"name": "x"}
    )

    assert response.status_code == 404


def test_group_admin_has_no_rights_on_a_members_public_trail(
    client: TestClient,
    create_user: CreateUser,
    make_group: MakeGroup,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
) -> None:
    owner, admin = create_user(), create_user()
    make_group(admins=(admin,), members=(owner,))
    trail = post_trail(owner, visibility="public")

    response = client.patch(
        f"/api/trails/{trail['id']}", headers=auth_headers(admin), json={"name": "x"}
    )

    assert response.status_code == 403


def test_patch_cannot_change_owner_or_source(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, post_trail: PostTrail
) -> None:
    owner, other = create_user(), create_user()
    trail = post_trail(owner)

    body = client.patch(
        f"/api/trails/{trail['id']}",
        headers=auth_headers(owner),
        json={"owner_user_id": str(other.id), "source": "osm", "osm_relation_id": 5},
    ).json()

    assert body["owner_user_id"] == str(owner.id)
    assert body["source"] == "manual"
    assert body["osm_relation_id"] is None


@pytest.mark.parametrize(
    "fields",
    [
        {"name": ""},
        {"name": "   "},
        {"name": "x" * 201},
        {"name": None},
        {"distance_m": -5},
        {"distance_m": None},
        {"elevation_gain_m": -5},
        {"elevation_gain_m": None},
        {"visibility": None},
        {"visibility": "secret"},
    ],
)
def test_patch_rejects_invalid_input(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
    fields: dict[str, Any],
) -> None:
    owner = create_user()
    trail = post_trail(owner, name="Keep")
    url = f"/api/trails/{trail['id']}"

    assert client.patch(url, headers=auth_headers(owner), json=fields).status_code == 422
    assert client.get(url, headers=auth_headers(owner)).json()["name"] == "Keep"


def test_patch_leaves_other_fields_and_can_clear_optional_ones(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, post_trail: PostTrail
) -> None:
    owner = create_user()
    trail = post_trail(owner, description="Keep me", highest_point_m=1000)
    url = f"/api/trails/{trail['id']}"

    body = client.patch(url, headers=auth_headers(owner), json={"distance_m": 1}).json()
    assert (body["description"], body["highest_point_m"]) == ("Keep me", 1000)

    body = client.patch(
        url, headers=auth_headers(owner), json={"description": None, "highest_point_m": None}
    ).json()
    assert (body["description"], body["highest_point_m"]) == (None, None)


def test_rename_to_a_taken_name_conflicts_but_changing_only_case_is_fine(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, post_trail: PostTrail
) -> None:
    owner = create_user()
    post_trail(owner, name="Taken")
    trail = post_trail(owner, name="Mine")
    url = f"/api/trails/{trail['id']}"

    assert_name_taken(client.patch(url, headers=auth_headers(owner), json={"name": "TAKEN"}))
    assert client.get(url, headers=auth_headers(owner)).json()["name"] == "Mine"
    assert client.patch(url, headers=auth_headers(owner), json={"name": "MINE"}).status_code == 200


# Changing visibility


def test_owner_can_move_a_trail_between_visibilities(
    client: TestClient,
    create_user: CreateUser,
    make_group: MakeGroup,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
) -> None:
    owner, member, outsider = create_user(), create_user(), create_user()
    group = make_group(members=(owner, member))
    trail = post_trail(owner)
    url = f"/api/trails/{trail['id']}"

    assert client.get(url, headers=auth_headers(member)).status_code == 404

    body = client.patch(
        url, headers=auth_headers(owner), json={"visibility": "group", "group_id": str(group.id)}
    ).json()
    assert (body["visibility"], body["group_id"]) == ("group", str(group.id))
    assert client.get(url, headers=auth_headers(member)).status_code == 200
    assert client.get(url, headers=auth_headers(outsider)).status_code == 404

    body = client.patch(url, headers=auth_headers(owner), json={"visibility": "public"}).json()
    # The group is dropped without having to be cleared explicitly.
    assert (body["visibility"], body["group_id"]) == ("public", None)
    assert client.get(url, headers=auth_headers(outsider)).status_code == 200

    body = client.patch(url, headers=auth_headers(owner), json={"visibility": "private"}).json()
    assert body["visibility"] == "private"
    assert client.get(url, headers=auth_headers(outsider)).status_code == 404
    assert client.get(url, headers=auth_headers(member)).status_code == 404


def test_moving_to_a_group_rechecks_membership(
    client: TestClient,
    create_user: CreateUser,
    make_group: MakeGroup,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
) -> None:
    owner = create_user()
    private_group = make_group(members=(create_user(),))
    public_group = make_group(visibility=GroupVisibility.PUBLIC)
    trail = post_trail(owner, name="Stays private")
    url = f"/api/trails/{trail['id']}"

    for group, status in ((private_group, 404), (public_group, 403)):
        response = client.patch(
            url,
            headers=auth_headers(owner),
            json={"visibility": "group", "group_id": str(group.id)},
        )
        assert response.status_code == status

    assert client.get(url, headers=auth_headers(owner)).json()["visibility"] == "private"


def test_admin_cannot_move_a_trail_to_a_group_they_are_not_in(
    client: TestClient,
    create_user: CreateUser,
    make_group: MakeGroup,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
) -> None:
    owner, admin = create_user(), create_user()
    group = make_group(admins=(admin,), members=(owner,))
    # The owner is a member there, the admin is not.
    other_group = make_group(members=(owner,))
    trail = post_trail(owner, visibility="group", group_id=str(group.id))

    response = client.patch(
        f"/api/trails/{trail['id']}",
        headers=auth_headers(admin),
        json={"group_id": str(other_group.id)},
    )

    assert response.status_code == 403
    assert response.json() == {"detail": "sharing_creator_only"}


def test_visibility_change_requires_a_consistent_group(
    client: TestClient,
    create_user: CreateUser,
    make_group: MakeGroup,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
) -> None:
    owner = create_user()
    group = make_group(members=(owner,))
    trail = post_trail(owner)
    url = f"/api/trails/{trail['id']}"

    missing = client.patch(url, headers=auth_headers(owner), json={"visibility": "group"})
    assert (missing.status_code, missing.json()["detail"]) == (422, "group_required")

    stray = client.patch(url, headers=auth_headers(owner), json={"group_id": str(group.id)})
    assert (stray.status_code, stray.json()["detail"]) == (422, "group_not_allowed")

    shared = post_trail(owner, name="Shared", visibility="group", group_id=str(group.id))
    cleared = client.patch(
        f"/api/trails/{shared['id']}", headers=auth_headers(owner), json={"group_id": None}
    )
    assert (cleared.status_code, cleared.json()["detail"]) == (422, "group_required")


@pytest.mark.parametrize(
    ("taken_in", "move_to"),
    [("public", "public"), ("private", "private"), ("group", "group")],
)
def test_moving_into_a_scope_rechecks_the_name(
    client: TestClient,
    create_user: CreateUser,
    make_group: MakeGroup,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
    taken_in: str,
    move_to: str,
) -> None:
    owner = create_user()
    group = make_group(members=(owner,))
    group_fields = {"group_id": str(group.id)}
    post_trail(
        owner, name="Krim", visibility=taken_in, **(group_fields if taken_in == "group" else {})
    )
    # A trail with the same name in a different scope.
    start = "private" if taken_in != "private" else "public"
    trail = post_trail(owner, name="krim", visibility=start)

    response = client.patch(
        f"/api/trails/{trail['id']}",
        headers=auth_headers(owner),
        json={"visibility": move_to, **(group_fields if move_to == "group" else {})},
    )

    assert_name_taken(response)
    after = client.get(f"/api/trails/{trail['id']}", headers=auth_headers(owner)).json()
    assert after["visibility"] == start


@pytest.mark.parametrize("visibility", ["public", "private"])
def test_group_admin_cannot_change_who_sees_a_members_trail(
    client: TestClient,
    create_user: CreateUser,
    make_group: MakeGroup,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
    visibility: str,
) -> None:
    owner, admin = create_user(), create_user()
    group = make_group(admins=(admin,), members=(owner,))
    trail = post_trail(owner, visibility="group", group_id=str(group.id))
    url = f"/api/trails/{trail['id']}"

    response = client.patch(url, headers=auth_headers(admin), json={"visibility": visibility})

    assert response.status_code == 403
    assert response.json() == {"detail": "sharing_creator_only"}
    assert client.get(url, headers=auth_headers(owner)).json()["visibility"] == "group"


def test_group_admin_can_edit_other_fields_while_sending_the_same_sharing(
    client: TestClient,
    create_user: CreateUser,
    make_group: MakeGroup,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
) -> None:
    owner, admin = create_user(), create_user()
    group = make_group(admins=(admin,), members=(owner,))
    trail = post_trail(owner, visibility="group", group_id=str(group.id))
    url = f"/api/trails/{trail['id']}"

    response = client.patch(
        url,
        headers=auth_headers(admin),
        json={"name": "Corrected", "visibility": "group", "group_id": str(group.id)},
    )

    assert response.status_code == 200
    assert response.json()["name"] == "Corrected"
    assert response.json()["can_change_sharing"] is False
    assert client.get(url, headers=auth_headers(owner)).json()["can_change_sharing"] is True


def test_creator_who_left_the_group_still_sees_and_edits_their_trail(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    make_group: MakeGroup,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
) -> None:
    owner, admin, outsider = create_user(), create_user(), create_user()
    group = make_group(admins=(admin,), members=(owner,))
    trail = post_trail(owner, visibility="group", group_id=str(group.id))
    url = f"/api/trails/{trail['id']}"
    session.delete(session.get(GroupMembership, (group.id, owner.id)))
    session.commit()

    assert client.get(url, headers=auth_headers(owner)).status_code == 200
    listed = client.get("/api/trails", headers=auth_headers(owner)).json()["items"]
    assert trail["id"] in [item["id"] for item in listed]
    assert client.patch(url, headers=auth_headers(owner), json={"name": "Mine"}).status_code == 200
    assert client.get(url, headers=auth_headers(outsider)).status_code == 404


def test_ownerless_group_trail_cannot_leave_the_group(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    make_group: MakeGroup,
    auth_headers: AuthHeaders,
) -> None:
    admin = create_user()
    group = make_group(admins=(admin,))
    trail = Trail(
        name="Orphan",
        visibility=TrailVisibility.GROUP,
        group_id=group.id,
        owner_user_id=None,
        source=TrailSource.MANUAL,
        distance_m=1,
    )
    session.add(trail)
    session.commit()
    url = f"/api/trails/{trail.id}"

    for visibility in ("private", "public"):
        response = client.patch(url, headers=auth_headers(admin), json={"visibility": visibility})
        assert (response.status_code, response.json()["detail"]) == (422, "trail_has_no_owner")
    assert client.patch(url, headers=auth_headers(admin), json={"name": "x"}).status_code == 200
    assert client.get(url, headers=auth_headers(admin)).json()["owner_name"] is None


# Archiving


def test_trails_cannot_be_deleted(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, post_trail: PostTrail
) -> None:
    owner = create_user()
    trail = post_trail(owner)
    url = f"/api/trails/{trail['id']}"

    assert client.delete(url, headers=auth_headers(owner)).status_code == 405
    assert client.get(url, headers=auth_headers(owner)).status_code == 200


def test_archived_trail_is_not_listed_but_stays_readable_and_can_be_unarchived(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, post_trail: PostTrail
) -> None:
    owner, other = create_user(), create_user()
    trail = post_trail(owner, visibility="public", name="Old")
    url = f"/api/trails/{trail['id']}"

    def listed(user: User, **params: Any) -> list[str]:
        response = client.get("/api/trails", headers=auth_headers(user), params=params)
        return [item["name"] for item in response.json()["items"]]

    assert client.post(f"{url}/archive", headers=auth_headers(owner)).json()["archived"] is True

    assert listed(owner) == []
    assert listed(other) == []
    assert listed(owner, include_archived=True) == ["Old"]
    assert client.get(url, headers=auth_headers(other)).json()["archived"] is True

    assert client.post(f"{url}/unarchive", headers=auth_headers(owner)).json()["archived"] is False
    assert listed(other) == ["Old"]


def test_include_archived_does_not_reveal_hidden_trails(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, post_trail: PostTrail
) -> None:
    owner = create_user()
    trail = post_trail(owner)
    client.post(f"/api/trails/{trail['id']}/archive", headers=auth_headers(owner))

    body = client.get(
        "/api/trails", headers=auth_headers(create_user()), params={"include_archived": True}
    ).json()

    assert body["total"] == 0


def test_archiving_twice_changes_nothing(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
) -> None:
    owner = create_user()
    trail = post_trail(owner)
    url = f"/api/trails/{trail['id']}/archive"
    assert client.post(url, headers=auth_headers(owner)).status_code == 200
    first = session.get(Trail, uuid.UUID(trail["id"]))
    assert first is not None
    archived_at = first.archived_at

    assert client.post(url, headers=auth_headers(owner)).status_code == 200

    session.expire_all()
    again = session.get(Trail, uuid.UUID(trail["id"]))
    assert again is not None
    assert again.archived_at == archived_at


def test_unarchiving_a_trail_that_is_not_archived_is_harmless(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, post_trail: PostTrail
) -> None:
    owner = create_user()
    trail = post_trail(owner)

    response = client.post(f"/api/trails/{trail['id']}/unarchive", headers=auth_headers(owner))

    assert (response.status_code, response.json()["archived"]) == (200, False)


def test_an_archived_trail_still_holds_its_name(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, post_trail: PostTrail
) -> None:
    owner = create_user()
    trail = post_trail(owner, name="Krim")
    client.post(f"/api/trails/{trail['id']}/archive", headers=auth_headers(owner))

    # Otherwise unarchiving it could produce two trails with one name.
    assert_name_taken(
        client.post("/api/trails", headers=auth_headers(owner), json=trail_body(name="Krim"))
    )


# Listing


def names(response: Any) -> list[str]:
    assert response.status_code == 200, response.text
    return [item["name"] for item in response.json()["items"]]


def test_list_shows_only_what_the_user_can_see(
    client: TestClient,
    create_user: CreateUser,
    make_group: MakeGroup,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
) -> None:
    me, other = create_user(), create_user()
    my_group = make_group(members=(me, other))
    other_group = make_group(members=(other,))
    post_trail(me, name="A my private")
    post_trail(other, name="B their public", visibility="public")
    post_trail(other, name="C their private")
    post_trail(other, name="D shared with me", visibility="group", group_id=str(my_group.id))
    post_trail(other, name="E not shared", visibility="group", group_id=str(other_group.id))

    response = client.get("/api/trails", headers=auth_headers(me))

    assert names(response) == ["A my private", "B their public", "D shared with me"]
    assert response.json()["total"] == 3


def test_list_summary_fields(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, post_trail: PostTrail
) -> None:
    owner = create_user()
    trail = post_trail(owner, name="Krim", visibility="public")

    mine = client.get("/api/trails", headers=auth_headers(owner)).json()["items"][0]
    theirs = client.get("/api/trails", headers=auth_headers(create_user())).json()["items"][0]

    assert mine == {
        "id": trail["id"],
        "name": "Krim",
        "visibility": "public",
        "group_id": None,
        "owner_user_id": str(owner.id),
        "can_edit": True,
        "source": "manual",
        "distance_m": 4200,
        "elevation_gain_m": 350,
        "archived": False,
    }
    assert theirs["can_edit"] is False


def test_list_scopes(
    client: TestClient,
    create_user: CreateUser,
    make_group: MakeGroup,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
) -> None:
    me, other = create_user(), create_user()
    group = make_group(members=(me, other))
    second_group = make_group(members=(me,))
    post_trail(me, name="My private")
    post_trail(me, name="My public", visibility="public")
    post_trail(me, name="My shared", visibility="group", group_id=str(group.id))
    post_trail(other, name="Their public", visibility="public")
    post_trail(other, name="Their shared", visibility="group", group_id=str(group.id))
    post_trail(me, name="Second group", visibility="group", group_id=str(second_group.id))
    headers = auth_headers(me)

    def in_scope(**params: Any) -> list[str]:
        return names(client.get("/api/trails", headers=headers, params=params))

    assert in_scope(scope="public") == ["My public", "Their public"]
    assert in_scope(scope="mine") == ["My private", "My public", "My shared", "Second group"]
    assert in_scope(scope="group") == ["My shared", "Second group", "Their shared"]
    assert in_scope(scope="group", group_id=str(group.id)) == ["My shared", "Their shared"]
    assert len(in_scope(scope="all")) == 6


def test_group_filter_shows_nothing_for_a_group_the_user_is_not_in(
    client: TestClient,
    create_user: CreateUser,
    make_group: MakeGroup,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
) -> None:
    owner = create_user()
    group = make_group(members=(owner,))
    post_trail(owner, visibility="group", group_id=str(group.id))

    response = client.get(
        "/api/trails",
        headers=auth_headers(create_user()),
        params={"group_id": str(group.id), "scope": "group"},
    )

    assert names(response) == []


def test_search_is_a_case_insensitive_substring_match_and_treats_wildcards_literally(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, post_trail: PostTrail
) -> None:
    me = create_user()
    post_trail(me, name="Šmarna gora")
    post_trail(me, name="Pot na Krim")
    post_trail(me, name="100% strmo")
    post_trail(me, name="a_b")
    post_trail(me, name="axb")
    headers = auth_headers(me)

    def search(q: str) -> list[str]:
        return names(client.get("/api/trails", headers=headers, params={"q": q}))

    assert search("KRIM") == ["Pot na Krim"]
    assert search("šMARNA") == ["Šmarna gora"]
    assert search("%") == ["100% strmo"]
    assert search("a_b") == ["a_b"]
    assert search("nothing like this") == []
    # Nothing to search for means no filter.
    assert len(search("   ")) == 5
    # A NUL byte would make the database driver fail.
    assert search("Kr\x00im") == []


def test_search_does_not_reveal_hidden_trails(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, post_trail: PostTrail
) -> None:
    post_trail(create_user(), name="Secret place")

    response = client.get(
        "/api/trails", headers=auth_headers(create_user()), params={"q": "secret"}
    )

    assert names(response) == []


def test_sorting(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    post_trail: PostTrail,
) -> None:
    me = create_user()
    post_trail(me, name="beta", distance_m=300, elevation_gain_m=50)
    post_trail(me, name="Alpha", distance_m=200, elevation_gain_m=500)
    post_trail(me, name="Gamma", distance_m=100, elevation_gain_m=0)
    session.add(
        Trail(
            name="No elevation",
            visibility=TrailVisibility.PRIVATE,
            owner_user_id=me.id,
            source=TrailSource.OSM,
            distance_m=400,
        )
    )
    session.commit()
    headers = auth_headers(me)

    def order(**params: Any) -> list[str]:
        return names(client.get("/api/trails", headers=headers, params=params))

    assert order() == ["Alpha", "beta", "Gamma", "No elevation"]
    assert order(order="desc") == ["No elevation", "Gamma", "beta", "Alpha"]
    assert order(sort="distance") == ["Gamma", "Alpha", "beta", "No elevation"]
    assert order(sort="distance", order="desc") == ["No elevation", "beta", "Alpha", "Gamma"]
    assert order(sort="elevation") == ["Gamma", "beta", "Alpha", "No elevation"]
    # Unknown elevation stays last in both directions.
    assert order(sort="elevation", order="desc") == ["Alpha", "beta", "Gamma", "No elevation"]


def test_pagination(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, post_trail: PostTrail
) -> None:
    me = create_user()
    for name in ("A", "B", "C"):
        post_trail(me, name=name)

    body = client.get(
        "/api/trails", headers=auth_headers(me), params={"limit": 1, "offset": 1}
    ).json()

    assert [item["name"] for item in body["items"]] == ["B"]
    assert (body["total"], body["limit"], body["offset"]) == (3, 1, 1)


@pytest.mark.parametrize(
    "params",
    [
        {"limit": 0},
        {"limit": 201},
        {"offset": -1},
        {"scope": "everything"},
        {"sort": "owner"},
        {"order": "up"},
        {"group_id": "1"},
        {"q": "x" * 201},
    ],
)
def test_list_rejects_invalid_parameters(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    params: dict[str, Any],
) -> None:
    response = client.get("/api/trails", headers=auth_headers(create_user()), params=params)

    assert response.status_code == 422
