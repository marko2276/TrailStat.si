# ADR 0001: Installable web app (PWA) as the single client

- Status: accepted
- Date: 2026-11-02

## Context

The app must work on PC, iOS and Android. Live GPS tracking is out of scope, so no native device features are required.

## Decision

Build one TypeScript + React web app, installable as a PWA. If app-store presence is needed later, wrap it with Capacitor.

## Consequences

One codebase for all platforms. No app-store review for releases. Some iOS PWA limitations (e.g. push notifications) apply but are not needed for the MVP.
