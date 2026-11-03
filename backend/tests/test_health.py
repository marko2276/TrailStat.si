from collections.abc import Iterator
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app.db import get_session
from app.main import app


@pytest.fixture
def client() -> Iterator[TestClient]:
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_liveness(client: TestClient) -> None:
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_readiness_against_real_database(client: TestClient) -> None:
    """Needs the compose database, with migrations applied."""
    response = client.get("/api/health/ready")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_readiness_reports_database_failure(client: TestClient) -> None:
    session = MagicMock()
    session.execute.side_effect = OperationalError("SELECT 1", {}, Exception("secret-detail"))
    app.dependency_overrides[get_session] = lambda: session

    response = client.get("/api/health/ready")

    assert response.status_code == 503
    assert response.json() == {"detail": "Database unavailable"}
