# ADR 0003: Self-hosted Zitadel for authentication (OIDC)

- Status: accepted
- Date: 2026-11-02

## Context

User credentials must be handled by an open-source authentication service hosted in the EU, without US big-tech providers. Hanko, Zitadel, Keycloak, Authentik and Ory were considered.

## Decision

Use self-hosted Zitadel (Swiss, open source). The backend only validates OIDC tokens. No Google/Apple social login.

## Consequences

Passkeys, MFA and e-mail login out of the box. Because only standard OIDC is used, the provider can be swapped (e.g. for Hanko or Keycloak). One more service to operate and back up.
