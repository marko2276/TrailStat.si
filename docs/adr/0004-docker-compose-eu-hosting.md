# ADR 0004: Docker Compose deployment on EU infrastructure

- Status: accepted
- Date: 2026-11-02

## Context

The app starts on a home server and should move to external hosting when it grows. All data must stay in the EU.

## Decision

Run every component as a container orchestrated with Docker Compose behind Caddy. External hosting will be an EU provider (Hetzner, OVHcloud or Scaleway). No Cloudflare.

## Consequences

Moving hosts means copying the compose file, restoring a database dump and updating DNS. The home server needs port forwarding and a (dynamic) DNS name.
