# TrailStat.si — Architecture

> Status: draft · Last updated: 2026-11-02 · Key decisions are recorded in [`docs/adr/`](adr/).

## Overview

```
                 ┌──────────────────────────────────────────────────┐
 Browser / PWA   │ Caddy — reverse proxy, automatic HTTPS           │
 (PC, iOS,  ───► │   /        → frontend  (static PWA files)        │
  Android)       │   /api     → backend   (Python, FastAPI)         │
                 │   auth.*   → Zitadel   (OIDC identity provider)  │
                 │                                                  │
                 │ backend ──► PostgreSQL + PostGIS  (own volume)   │
                 │         ──► Overpass API          (OSM import)   │
                 │         ──► elevation service     (Copernicus DEM)│
                 │         ──► SMTP (EU provider)    (invite e-mails)│
                 └──────────────── docker compose ──────────────────┘
```

## Components

| Component | Technology | Notes |
|---|---|---|
| Frontend | TypeScript, React, Vite, PWA | One codebase for desktop and mobile. Can be wrapped with Capacitor for app stores later. |
| Maps | MapLibre GL JS | Vector tiles from MapTiler (CH) or self-hosted Protomaps. Not the openstreetmap.org tile servers (usage policy forbids app use). |
| Elevation chart | Lightweight chart library | Rendered from the trail's elevation profile. |
| i18n | i18next (frontend), Babel/gettext (backend e-mails) | `en`, `sl` at launch. |
| Backend | Python 3.12+, FastAPI, SQLAlchemy 2, GeoAlchemy2, Alembic, Pydantic | REST API with generated OpenAPI spec. Validates OIDC access tokens; never sees passwords. |
| Database | PostgreSQL 16 + PostGIS | Separate container with named volume. Trail geometries stored as `LineString` (SRID 4326). |
| Identity | Zitadel (self-hosted) | E-mail + password, passkeys, MFA. Standard OIDC, so the provider is swappable. |
| OSM import | Overpass API | Query hiking route relations (`route=hiking`), assemble geometry, store OSM relation ID. Self-host Overpass if volume grows. |
| Elevation | Open Topo Data (self-hosted) with Copernicus GLO-30 DEM | Computes elevation gain/loss and profile for trails with geometry. Start with a Slovenia/Alps extract. |
| E-mail | SMTP via EU provider | Group invitations, join-request notifications. |
| Reverse proxy | Caddy | Automatic Let's Encrypt certificates. |

## Data model (first draft)

```
User(id, oidc_subject, display_name, email, locale, created_at)

Group(id, name, description, visibility[public|private], created_by, created_at)
GroupMembership(group_id, user_id, role[admin|member], joined_at)
GroupGuest(id, group_id, name, created_by)
GroupInvitation(id, group_id, email, token, invited_by, status, expires_at)
JoinRequest(id, group_id, user_id, status, created_at)

Trail(id, name, description, visibility[public|private|group],
      owner_user_id, group_id?, source[osm|manual], osm_relation_id?,
      distance_m, elevation_gain_m, elevation_loss_m?, geometry?, elevation_profile?,
      created_at, updated_at)
  -- unique(name) within scope: public | (owner, private) | (group, group)

Hike(id, trail_id, group_id?, recorded_by, start_at (timestamptz), duration_s, notes, created_at)
HikeAttendee(hike_id, user_id? | guest_id?)
```

A personal hike has no `group_id` and a single attendee (the user). Personal
statistics aggregate every hike where the user is an attendee.

## Deployment

- **Now:** home server running `docker compose`. Ports 80/443 forwarded to Caddy.
- **Later:** same compose stack on an EU VPS (Hetzner, OVHcloud, Scaleway); optionally move PostgreSQL to a managed EU database.
- **Backups:** nightly `pg_dump` to off-site EU storage (e.g. Hetzner Storage Box); restore tested regularly.
- **CI:** GitHub Actions — lint, tests, build and publish container images.

## Future components

- **Routing engine** (BRouter or Valhalla) for creating trails by clicking points on the map.
- **GPX parser** for uploading trails.
