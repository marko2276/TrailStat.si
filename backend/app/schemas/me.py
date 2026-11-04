import uuid
from typing import Annotated

from pydantic import AfterValidator, Field, StringConstraints

from app.schemas.common import ApiModel, no_control_characters


class Me(ApiModel):
    id: uuid.UUID
    email: str
    display_name: str
    country: str | None
    city: str | None
    avatar_url: str | None
    locale: str | None


DisplayName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=100),
    AfterValidator(no_control_characters),
]
City = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=100),
    AfterValidator(no_control_characters),
]


class MeUpdate(ApiModel):
    """Only fields present in the request change. Country and city can be cleared with null.
    The e-mail address is managed in Hanko."""

    display_name: DisplayName | None = None
    country: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")
    city: City | None = None
    # A pattern, not a fixed list: adding a language must not need a backend change.
    locale: str | None = Field(default=None, pattern=r"^[a-z]{2}(-[A-Z]{2})?$")
