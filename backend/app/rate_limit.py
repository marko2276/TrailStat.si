"""Per-user rate limits, for actions that cost someone else something: e-mails and Overpass.

The counts are kept in this process's memory. That is enough for the single-process deployment
in compose.yaml. With several workers each would count separately, and a restart forgets them.
"""

import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass

from app.errors import ApiError


@dataclass(frozen=True)
class RateLimit:
    action: str
    max_calls: int
    window_s: float


# Creating and resending count together.
INVITATION_EMAILS = RateLimit("invitation_email", 20, 3600)
JOIN_REQUESTS = RateLimit("join_request", 10, 3600)
# Search, preview and import count together.
OSM_REQUESTS = RateLimit("osm", 20, 60)

_lock = threading.Lock()
# Bounded by the number of users and the limits: a refused call is not recorded.
_calls: dict[tuple[str, uuid.UUID], deque[float]] = {}


def enforce(limit: RateLimit, user_id: uuid.UUID) -> None:
    """Records a call, or raises 429 if the user has made too many within the sliding window."""
    now = time.monotonic()
    with _lock:
        calls = _calls.setdefault((limit.action, user_id), deque())
        while calls and calls[0] <= now - limit.window_s:
            calls.popleft()
        if len(calls) >= limit.max_calls:
            raise ApiError(429, "rate_limited")
        calls.append(now)


def reset() -> None:
    """Forgets all calls. For tests."""
    with _lock:
        _calls.clear()
