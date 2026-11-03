# ADR 0003: Hanko for authentication (cloud during development, self-hosted for launch)

- Status: accepted
- Date: 2026-11-03

## Context

User credentials must be handled by an open-source authentication service.
In production all data must stay in the EU without US big-tech providers.
During development a free hosted plan is preferred, so there is nothing to
operate yet. Hanko, Zitadel, Keycloak, Authentik and Ory were considered.

Passkeys are bound to a relying party ID, which must match the domain of the
page where the user signs in. With embedded login components that is the app's
own domain, not the authentication API's domain.

## Decision

Use **Hanko** (German, open source, AGPL-3.0):

1. **Development:** Hanko Cloud free plan (10,000 monthly active users),
   configured on the custom domain `auth.trailstat.si` from day one.
2. **Before the first real users:** self-host Hanko in the Docker Compose
   stack on the same domain, with its own database inside the existing
   PostgreSQL server, and migrate the (test) users.

Integration:

- The frontend embeds Hanko's login and profile components (`@teamhanko/hanko-elements`).
- The backend validates Hanko session tokens (JWT) against Hanko's public
  keys (JWKS endpoint) and creates the local user on first login, keyed by
  the Hanko user ID. The backend never sees passwords.
- The passkey relying party ID is `trailstat.si`. It does not change when Hanko
  moves from cloud to self-hosted, provided the stored credentials are migrated.
- The custom domain `auth.trailstat.si` keeps the API URL stable across that move
  and keeps it on the same site as the app, for session cookies.
- Local development uses a second Hanko project configured for `localhost`,
  because passkeys for `trailstat.si` cannot be used on `localhost`.
- Login methods: passkeys, e-mail + password and e-mail passcodes. No
  Google/Apple/Microsoft social login.

Zitadel was not chosen: its free cloud plan is much smaller, custom
domains are not free, and its organisations and roles are not needed, because groups and admin
roles live in TrailStat's own database.

## Consequences

- No authentication service to operate during development.
- Hanko Cloud reportedly runs on AWS (Frankfurt). This is accepted only for
  the development stage. Self-hosting before launch is required by NFR-3.
- Hanko is not a standard OIDC provider for this flow. Token validation is
  kept behind a small backend module (JWT + JWKS), so another provider can
  still be swapped in later.
- Slovenian translations for the Hanko components may need to be supplied
  as custom translations.
