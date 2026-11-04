import uuid
from datetime import datetime
from typing import Annotated

from pydantic import AwareDatetime, ConfigDict, Field, StringConstraints

from app.schemas.common import ApiModel

# Long enough for a multi-day trek, short enough to catch typing errors.
MAX_DURATION_S = 30 * 24 * 3600

DurationSeconds = Annotated[int, Field(gt=0, le=MAX_DURATION_S)]
Notes = Annotated[str, StringConstraints(strip_whitespace=True, max_length=5000)]


class HikeTrail(ApiModel):
    id: uuid.UUID
    name: str
    distance_m: int
    elevation_gain_m: int | None
    archived: bool


class HikeAttendeeRead(ApiModel):
    """Exactly one of `user_id` and `guest_id` is set."""

    user_id: uuid.UUID | None
    guest_id: uuid.UUID | None
    name: str


class HikeRead(ApiModel):
    id: uuid.UUID
    trail: HikeTrail
    group_id: uuid.UUID | None
    group_name: str | None
    recorded_by: uuid.UUID | None
    start_at: datetime
    duration_s: int
    notes: str | None
    attendees: list[HikeAttendeeRead]
    can_edit: bool
    can_delete: bool


class HikeCreate(ApiModel):
    trail_id: uuid.UUID
    start_at: AwareDatetime
    duration_s: DurationSeconds
    notes: Notes | None = None
    group_id: uuid.UUID | None = None
    attendee_user_ids: list[uuid.UUID] = []
    attendee_guest_ids: list[uuid.UUID] = []


class HikeUpdate(ApiModel):
    """Only fields present in the request change. A hike can't move to another group, so
    unknown fields such as `group_id` are rejected rather than silently ignored."""

    model_config = ConfigDict(from_attributes=True, extra="forbid")

    trail_id: uuid.UUID | None = None
    start_at: AwareDatetime | None = None
    duration_s: DurationSeconds | None = None
    notes: Notes | None = None
    attendee_user_ids: list[uuid.UUID] | None = None
    attendee_guest_ids: list[uuid.UUID] | None = None
