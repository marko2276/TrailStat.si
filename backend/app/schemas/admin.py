"""The admin page: totals only, never anyone's data."""

from datetime import date, datetime

from pydantic import BaseModel


class UserTotals(BaseModel):
    total: int
    new_7_days: int
    new_30_days: int
    # Used the app on at least one of the last 30 days.
    active_30_days: int
    # By the language of the app; "unknown" before the first page was shown.
    by_language: dict[str, int]


class ContentTotals(BaseModel):
    trails: int
    trails_by_source: dict[str, int]
    trails_by_visibility: dict[str, int]
    trails_archived: int
    hikes: int
    hikes_30_days: int
    groups: int
    memberships: int
    guests: int
    pending_invitations: int
    pending_join_requests: int


class TableSize(BaseModel):
    name: str
    size_bytes: int
    # PostgreSQL's estimate, updated by autovacuum: close, not exact.
    rows_estimate: int


class DatabaseTotals(BaseModel):
    size_bytes: int
    largest_tables: list[TableSize]
    migration: str | None


class ElevationData(BaseModel):
    tiles: int
    size_bytes: int


class ServerStatus(BaseModel):
    version: str
    environment: str
    started_at: datetime
    today: date
    elevation_data: ElevationData
    email_configured: bool
    donations_bank_transfer: bool
    donations_flik: bool


class AdminStats(BaseModel):
    users: UserTotals
    content: ContentTotals
    database: DatabaseTotals
    server: ServerStatus
