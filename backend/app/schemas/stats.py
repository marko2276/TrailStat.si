import uuid
from datetime import datetime

from app.schemas.common import ApiModel
from app.schemas.hikes import HikeTrail


class Totals(ApiModel):
    hike_count: int
    total_distance_m: int
    total_elevation_gain_m: int
    total_duration_s: int
    # Exact, not rounded. 0 when there are no hikes.
    average_duration_s: float


class AttendeeTotals(ApiModel):
    """Exactly one of `user_id` and `guest_id` is set."""

    user_id: uuid.UUID | None
    guest_id: uuid.UUID | None
    name: str
    totals: Totals


class TrailBestTime(ApiModel):
    """The fastest hike on a trail. Of equally fast hikes, the first."""

    trail: HikeTrail
    hike_count: int
    best_duration_s: int
    best_hike_id: uuid.UUID
    best_start_at: datetime


class GroupStats(ApiModel):
    totals: Totals
    attendees: list[AttendeeTotals]
