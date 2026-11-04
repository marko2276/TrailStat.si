"""A huge offset is the client's mistake, not a server error, on every list."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.conftest import AuthHeaders, CreateUser
from tests.groups_helpers import make_group

LISTS = [
    "/api/trails",
    "/api/groups",
    "/api/groups?scope=public",
    "/api/hikes",
    "/api/groups/{group}/hikes",
    "/api/groups/{group}/invitations",
    "/api/groups/{group}/join-requests",
]


@pytest.mark.parametrize("path", LISTS)
@pytest.mark.parametrize(
    ("offset", "status"), [(2**63, 422), (2**31, 422), (10**30, 422), (-1, 422), (2**31 - 1, 200)]
)
def test_offset_is_capped(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    path: str,
    offset: int,
    status: int,
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])

    response = client.get(
        path.format(group=group.id), params={"offset": offset}, headers=auth_headers(admin)
    )

    assert response.status_code == status
