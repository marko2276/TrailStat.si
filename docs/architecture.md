# TrailStat.si — Architecture

> Status: draft · Last updated: 2026-11-02 · Key decisions are recorded in [`docs/adr/`](adr/).

## Overview

```
                 ┌──────────────────────────────────────────────────┐
 Browser / PWA   │ Caddy — reverse proxy, automatic HTTPS           │
 (PC, iOS,  ───► │   /        → frontend  (static PWA files)        │
  Android)       │   /api     → backend   (Python, FastAPI)         │
                 │   auth.*   → Hanko     (authentication)          │
                 │                                                  │
                 │ backend ──► PostgreSQL + PostGIS  (own volume)   │
                 │         ──► Overpass API          (OSM import)   │
                 │         ──► DEM files (read-only) (Copernicus DEM)│
                 │         ──► SMTP (Scaleway TEM)   (invite e-mails)│
                 └──────────────── docker compose ──────────────────┘
```

## Components

| Component | Technology | Notes |
|---|---|---|
| Frontend | TypeScript, React, Vite, PWA | One codebase for desktop and mobile. Can be wrapped with Capacitor for app stores later. |
| Maps | MapLibre GL JS | Vector tiles from OpenFreeMap by default, no key needed (`VITE_MAP_STYLE_URL`). Not the openstreetmap.org tile servers (usage policy forbids app use). |
| Elevation chart | Hand-written SVG | Rendered from the trail's elevation profile. |
| i18n | i18next (frontend), Babel/gettext (backend e-mails) | `en`, `sl` at launch. |
| Backend | Python 3.12+, FastAPI, SQLAlchemy 2, GeoAlchemy2, Alembic, Pydantic | REST API with generated OpenAPI spec. Validates Hanko session tokens (JWT via JWKS); never sees passwords. |
| Database | PostgreSQL 16 + PostGIS | Separate container with named volume. Trail geometries stored as `LineString` (SRID 4326). |
| Authentication | Hanko on `auth.trailstat.si` | Hanko Cloud (free plan) during development; self-hosted in the compose stack before launch. Passkeys, e-mail + password, e-mail passcodes. Frontend embeds `hanko-elements`. See ADR 0003. |
| OSM import | Overpass API | Query hiking route relations (`route=hiking`), assemble geometry, store OSM relation ID. Self-host Overpass if volume grows. |
| Elevation | Copernicus GLO-30 DEM GeoTIFFs read by the backend with `rasterio` | No separate service. Files are mounted read-only into the backend container (start with Slovenia/Alps, a few hundred MB). Sampled once per trail import to compute elevation gain/loss and the profile. |
| E-mail | SMTP via Scaleway Transactional Email | Group invitations, join-request notifications. See ADR 0006. |
| Reverse proxy | Caddy | Automatic Let's Encrypt certificates. |

## Data model (first draft)

```
User(id, auth_subject (Hanko user ID), email, display_name, country?, city?, avatar_url?, locale, created_at)
  -- avatar_url reserved for future avatar support (nullable, unused in MVP)

Group(id, name, description, visibility[public|private], created_by, created_at)
GroupMembership(group_id, user_id, role[admin|member], joined_at)
GroupGuest(id, group_id, nickname, created_by)   -- never linked to a User
GroupInvitation(id, group_id, email, token, invited_by, status, expires_at)
JoinRequest(id, group_id, user_id, status, created_at)

Trail(id, name, description, visibility[public|private|group],
      owner_user_id, group_id?, source[osm|manual|file], osm_relation_id?,
      distance_m, elevation_gain_m, elevation_loss_m?, geometry?, elevation_profile?,
      elevation_source[dem|file]?,
      archived_at?, created_at, updated_at)
  -- unique(name) within scope: public | (owner, private) | (group, group)
  -- trails are never deleted, only archived (archived_at set)
  -- owned by a user; group_id only shares it with a group

Hike(id, trail_id, group_id? (ON DELETE SET NULL), recorded_by, start_at (timestamptz), duration_s, notes, created_at)
HikeAttendee(hike_id, user_id? | guest_id?)
```

A personal hike has no `group_id` and a single attendee (the user). Personal
statistics aggregate every hike where the user is an attendee.

When a group is deleted: its hikes keep existing with `group_id = NULL` and
their user attendees (so they stay in personal statistics); guest attendees
and the group's guests are removed; trails shared with the group become
private to their owner.

## Deployment

- **Now:** home server running `docker compose`. Ports 80/443 forwarded to Caddy. Authentication uses Hanko Cloud during development.
- **Before launch:** Hanko self-hosted in the same compose stack, on the same `auth.trailstat.si` domain.
- **Later:** same compose stack on an EU VPS (Hetzner, OVHcloud, Scaleway); optionally move PostgreSQL to a managed EU database.
- **Backups:** nightly `pg_dump` to off-site EU storage (e.g. Hetzner Storage Box); restore tested regularly.
- **CI:** GitHub Actions — lint, tests, build and publish container images.

## Future components

- **Routing engine** (BRouter or Valhalla) for creating trails by clicking points on the map.
