import unicodedata

from pydantic import BaseModel, ConfigDict

# Far past any real list. PostgreSQL can't take an offset much above this without an error.
MAX_OFFSET = 2**31 - 1


def no_control_characters(value: str) -> str:
    if any(unicodedata.category(char) == "Cc" for char in value):
        raise ValueError("Control characters are not allowed")
    return value


def no_stray_control_characters(value: str) -> str:
    """For text of several lines."""
    if any(unicodedata.category(char) == "Cc" and char not in "\n\r\t" for char in value):
        raise ValueError("Control characters are not allowed")
    return value


class ApiModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page[T](BaseModel):
    """Envelope for every paginated list."""

    items: list[T]
    total: int
    limit: int
    offset: int
