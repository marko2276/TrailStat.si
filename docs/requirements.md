# TrailStat.si — Product Requirements

> Status: draft · Last updated: 2026-11-02
>
> This document holds the product vision, scope, roles, permissions and
> non-functional requirements. **Individual requirements are tracked as GitHub
> issues** (label `type:requirement`, grouped under `type:epic` issues) — the
> issues are the source of truth for details and progress.

## 1. Vision

TrailStat helps hikers keep a record of the trails they walk — alone or with
their hiking groups — and see their progress over time. It starts as a hobby
project focused on Slovenia, but is built to be international and to grow to
many users.

## 2. Scope

### MVP (milestone `MVP`)

| Area | In scope |
|---|---|
| Accounts | Sign up / sign in; profile with e-mail and name/nickname (required), country and city (optional), preferred language; account deletion & data export (GDPR) |
| Languages | English and Slovenian; easy to add more |
| Trails | Import from OpenStreetMap; create manually (name, distance, elevation); map + elevation profile for trails with geometry; public / private / group visibility |
| Hikes | Record a hike on a trail with start date & time and duration; personal or group hike with attendees (members and guests) |
| Groups | Create, invite by email, request to join public groups, multiple admins, guests, public / private visibility |
| Statistics | Personal and group statistics, filterable by day, month and year |
| Platform | Installable web app (PWA) for PC, iOS and Android; self-hosted with Docker on EU infrastructure |

### Later (milestone `Later`)

- GPX file upload to create a trail
- Create a trail by clicking start, intermediate and end points on the map (routed along real paths)
- Achievements and badges
- App Store / Google Play distribution (Capacitor wrapper)
- Live GPS tracking is **explicitly out of scope**

## 3. Concepts

| Term | Meaning |
|---|---|
| **User** | A person with an account. Required: e-mail and name/nickname. Optional: country, city. No other personal data is collected. Avatar support is planned for later. |
| **Group** | A set of members (users) and guests. Every group has ≥ 1 admin. |
| **Admin** | A group member with management rights. The creator is the first admin; there can be several. |
| **Guest** | A person in a group identified only by a nickname, without an account. Can attend group hikes; cannot log in. A guest is never linked to a user account, even if that person signs up later. |
| **Trail** | A route with a name, distance and elevation gain, optionally a map geometry. Identified internally by an ID; the name is unique within its scope (public trails / a user's private trails / a group's trails). A trail is always owned by its creator; group visibility only shares it with a group. Trails are never deleted, only archived. |
| **Hike** | One completed walk of a trail: start date & time + duration. A *personal hike* belongs to one user; a *group hike* belongs to a group and lists its attendees. |

## 4. Visibility and permissions

### Trails

| Visibility | Who can see | Who can edit / archive |
|---|---|---|
| Public | Everyone (all users) | Creator only |
| Private | Owner only | Owner |
| Group | Members of that group | Creator and group admins *(assumption)* |

Trails cannot be deleted, only **archived**. An archived trail is hidden from
browsing and cannot be chosen for new hikes, but existing hikes keep showing it
and it still counts in statistics. The creator can unarchive it.

### Groups

| Action | Who |
|---|---|
| Create a group | Any user (becomes admin) |
| See a public group | All users |
| See a private group | Members only |
| Invite by email | Admins |
| Request to join a public group | Any user; admins approve or reject |
| Promote / demote admins, remove members | Admins (a group always keeps ≥ 1 admin) |
| Delete group | Admins. Group hikes remain in the personal statistics of the attending users (no longer linked to a group); guests are removed. Trails are not owned by groups, so they remain with their creators — trails shared with the deleted group become private to their creator *(assumption)*. |
| Manage guests | Admins; any member can add a new guest while recording a hike *(assumption)* |
| Leave group | Any member (the last admin must first appoint another admin or delete the group) |

### Hikes

| Action | Personal hike | Group hike |
|---|---|---|
| Record | The user | Any group member |
| Edit | The user | The member who recorded it and admins *(assumption)* |
| Delete | The user | Admins only |
| Counts in personal stats | Yes | Yes — for every attending member |

## 5. Statistics

Available for a user (all their hikes, personal and group) and for each group
they belong to (that group's hikes):

- List of hikes
- Number of hikes
- Total distance, total elevation gain
- Total and average duration
- Filter by day, month and year
- Group view: breakdown per attendee (members and guests)

Distance and elevation come from the trail; time comes from the hike.

## 6. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | **Platforms** — responsive installable web app (PWA) working on desktop browsers, iOS Safari and Android Chrome. |
| NFR-2 | **Internationalisation** — all UI text and e-mails translatable; English and Slovenian at launch; dates, numbers and durations formatted per locale; adding a language requires no code change. |
| NFR-3 | **Data sovereignty** — all services and data hosted in the EU/EEA (or Switzerland); no dependency on US big-tech services (Google, Microsoft, Amazon, Apple, Cloudflare) at runtime. |
| NFR-4 | **Privacy** — GDPR compliant: privacy policy, account deletion, data export, minimal data collection. |
| NFR-5 | **Security** — authentication via a self-hosted open-source OIDC provider; passwords never handled by the TrailStat backend; HTTPS everywhere. |
| NFR-6 | **Portability** — the whole stack runs with Docker Compose, so it can move from a home server to external hosting without code changes. |
| NFR-7 | **Backups** — automated daily database backups with a tested restore procedure. |
| NFR-8 | **Licensing** — OpenStreetMap data attributed according to ODbL. |

## 7. Open questions

- When a public group's hikes are visible to everyone, which details are public (attendee names, stats)?
