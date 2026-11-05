# ADR 0005: OpenStreetMap for trails, Copernicus DEM for elevation

- Status: accepted
- Date: 2026-11-02

## Context

Trails should be importable from OpenStreetMap and shown on a map with an elevation profile. OSM does not contain reliable elevation data.

## Decision

Import hiking route relations via the Overpass API. Compute elevation in the backend by reading Copernicus GLO-30 DEM GeoTIFF files directly with `rasterio` (files mounted read-only into the backend container). The profile is resampled at a fixed interval and smoothed, ignoring changes below a small threshold, so elevation gain is not inflated by DEM noise. A separate elevation service (e.g. Open Topo Data) was considered and rejected: elevation is only needed once per trail import, so an extra container is not worth it. Render maps with MapLibre GL JS using the free OpenFreeMap tiles by default (no key needed), configurable with `VITE_MAP_STYLE_URL`, so MapTiler or self-hosted Protomaps tiles remain options.

## Consequences

Open data, EU sources. OSM data must be attributed (ODbL). DEM files need disk space and must be added when new regions are supported (start with Slovenia/Alps). Imports of trails outside the covered area get no elevation data until the matching tiles are added. Copernicus DEM licence attribution is required.
