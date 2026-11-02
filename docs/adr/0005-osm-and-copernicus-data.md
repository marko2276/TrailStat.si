# ADR 0005: OpenStreetMap for trails, Copernicus DEM for elevation

- Status: accepted
- Date: 2026-11-02

## Context

Trails should be importable from OpenStreetMap and shown on a map with an elevation profile. OSM does not contain reliable elevation data.

## Decision

Import hiking route relations via the Overpass API. Compute elevation with a self-hosted Open Topo Data service using the Copernicus GLO-30 DEM. Render maps with MapLibre GL JS using MapTiler or self-hosted Protomaps tiles.

## Consequences

Open data, EU sources. OSM data must be attributed (ODbL). The elevation service needs disk space for DEM tiles (start with Slovenia/Alps).
