import uuid

from app.schemas.common import ApiModel


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


class GroupStats(ApiModel):
    totals: Totals
    attendees: list[AttendeeTotals]
