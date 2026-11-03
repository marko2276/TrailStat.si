# ADR 0002: Python FastAPI backend with PostgreSQL + PostGIS

- Status: accepted
- Date: 2026-11-02

## Context

Backend should be Python. Trails are geographic data (lines, distances, areas).

## Decision

Use FastAPI, SQLAlchemy 2, GeoAlchemy2 and Alembic on PostgreSQL with PostGIS, running in its own container with a named volume.

## Consequences

Spatial queries are native in the database. The API is documented via OpenAPI, ready for other clients. The database can later move to a managed EU service without code changes.
