from pydantic import BaseModel, ConfigDict


class ApiModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page[T](BaseModel):
    """Envelope for every paginated list."""

    items: list[T]
    total: int
    limit: int
    offset: int
