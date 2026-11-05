from typing import Any

from fastapi import APIRouter

from app.auth import CurrentUser, DbSession
from app.errors import ApiError
from app.schemas.me import Me, MeUpdate
from app.services.account import delete_account, export_account

router = APIRouter(prefix="/me", tags=["me"])


@router.get("", response_model=Me)
def read_me(user: CurrentUser) -> object:
    return user


@router.patch("", response_model=Me)
def update_me(body: MeUpdate, user: CurrentUser, session: DbSession) -> object:
    changes = body.model_dump(exclude_unset=True)
    for required in ("display_name", "locale"):
        if required in changes and changes[required] is None:
            raise ApiError(422, f"{required}_required")
    for field, value in changes.items():
        setattr(user, field, value)
    session.commit()
    return user


@router.get("/export")
def export_me(user: CurrentUser, session: DbSession) -> dict[str, Any]:
    return export_account(session, user)


@router.delete("", status_code=204)
def delete_me(user: CurrentUser, session: DbSession) -> None:
    delete_account(session, user)
    session.commit()
