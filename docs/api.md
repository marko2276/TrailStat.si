# API contract between features

Every endpoint is under `/api` and needs `Authorization: Bearer <Hanko token>`. Lists return
`{items, total, limit, offset}` and take `limit` (default 50, maximum 200) and `offset`.
Timestamps are ISO 8601 with a time zone. Errors are `{"detail": "<code>"}`; the code is
translated by the frontend. The full, generated reference is at `/api/docs`.

This file lists what features rely on from each other. Change it together with the code.

## Trails (`app/api/trails.py`)

`TrailSummary`:
`{id, name, visibility: "public"|"private"|"group", group_id, owner_user_id, can_edit, source: "osm"|"manual",
distance_m, elevation_gain_m|null, archived: bool}`

- `GET /trails?q=&scope=all|public|mine|group&group_id=&include_archived=false&sort=name|distance|elevation&order=asc|desc`
  → page of `TrailSummary`, only trails the user can see. `scope=mine` means created by the user.
- `GET /trails/{id}` → `TrailSummary` + `{description, elevation_loss_m, highest_point_m, geometry: GeoJSON|null,
  elevation_profile: [[distance_m, elevation_m], ...]|null, osm_relation_id, created_at, updated_at}`

An archived trail stays readable by id, for hikes that reference it. Elevation fields and the profile
are null for manual trails without those values, and for imported trails outside the elevation data.
`owner_name` and `group_name` are also part of the detail. `geometry` is a GeoJSON LineString.

Only the creator can change `visibility` or `group_id` (403 `sharing_creator_only`); the detail's `can_change_sharing` tells the UI. Every write below returns the detail. Who may edit is `can_edit`: the creator, and for group trails
also the group's admins. Others get 403, or 404 if they cannot see the trail. Trails cannot be deleted.

- `POST /trails` `{name, distance_m, elevation_gain_m, description?, highest_point_m?, visibility, group_id?}`
  → 201. `group_id` is required for group visibility, which needs membership, and refused for others.
- `PATCH /trails/{id}` with any of those fields. Only the fields present change. Changing visibility or
  group rechecks membership and the name. Distance and elevation of imported trails cannot be changed
  (422 `osm_measurements_read_only`).
- `POST /trails/{id}/archive`, `POST /trails/{id}/unarchive`. Doing either twice changes nothing.

Names are unique within a scope, ignoring case, including archived trails: 409 `trail_name_taken`.

OpenStreetMap, through Overpass. A failing, overloaded or slow Overpass gives 503 `osm_unavailable`.

- `GET /trails/osm/search?q=&bbox=west,south,east,north` → page of
  `{relation_id, name, ref, network, start_name, end_name, bbox}`, `route=hiking` relations whose name
  contains `q`, at most 50. `q` needs two characters (422 `osm_search_too_short`).
- `GET /trails/osm/{relation_id}` → `{relation_id, name, geometry, distance_m, complete, member_length_m}`.
  `complete` is false if gaps or branches left part of the route out, as only the longest connected
  chain of its ways is kept. 404 `osm_route_not_found`; 422 `osm_route_without_geometry`.
- `POST /trails/osm/import` `{relation_id, name?, visibility, group_id?}` → 201. The name defaults to OSM's.

## Groups (`app/api/groups.py`)

- `GET /groups?scope=mine|public&q=` → page of
  `{id, name, description, visibility, is_member, is_admin, member_count}`
- `GET /groups/{id}` → the same fields. For non-members of a public group, `description` and
  `member_count` are null: they see only the name and the summary totals.
- `GET /groups/{id}/members` → members only: `{items: [{user_id, display_name, role}]}`, not paginated
- `GET /groups/{id}/guests` → members only: `{items: [{id, nickname}]}`, not paginated
- `POST /groups/{id}/guests` `{nickname}` → `{id, nickname}`. Any member (used while recording a hike).
  409 `guest_name_taken`; the comparison ignores case.

The rest of the groups API is used only by the groups feature:

- `POST /groups`, `PATCH|DELETE /groups/{id}`
- `PATCH|DELETE /groups/{id}/members/{user_id}`, `POST /groups/{id}/leave` (409 `last_admin`)
- `PATCH|DELETE /groups/{id}/guests/{guest_id}`
- `GET|POST /groups/{id}/invitations`, `POST .../{invitation_id}/resend`, `DELETE .../{invitation_id}`
- `GET /groups/invitations/{token}`, `POST .../{token}/accept`, `POST .../{token}/decline`
- `GET|POST /groups/{id}/join-requests`, `POST .../{request_id}/approve`, `POST .../{request_id}/reject`,
  `GET|DELETE /groups/{id}/join-requests/mine`

## Hikes (`app/api/hikes.py`)

`Hike`: `{id, trail: {id, name, distance_m, elevation_gain_m|null, archived}, group_id, group_name, recorded_by,
start_at, duration_s, notes, attendees: [{user_id, guest_id, name}], can_edit, can_delete}`

- `GET /hikes?start_from=&start_to=` → page of the user's hikes, newest first
- `GET /groups/{id}/hikes?start_from=&start_to=` → page of the group's hikes. Members only.
- `POST /hikes` `{trail_id, start_at, duration_s, notes, group_id, attendee_user_ids, attendee_guest_ids}`
- `GET|PATCH|DELETE /hikes/{id}`

Only attended hikes are in `GET /hikes`. `PATCH` changes the fields present; attendee lists replace
that kind of attendee. A hike can't change group. `DELETE` on a hike without a group (personal, or
its group was deleted) removes the caller's attendance, and the hike once no attendees remain.

Error codes (422): `trail_archived`, `trail_not_visible_to_group`, `attendees_required`,
`attendee_not_member`, `guest_not_in_group`, `personal_hike_attendees`, `start_at_in_future`,
`start_at_too_old`.

## Statistics (`app/api/stats.py`)

`Totals`: `{hike_count, total_distance_m, total_elevation_gain_m, total_duration_s, average_duration_s}`

`average_duration_s` is 0 without hikes and isn't rounded.

`start_from` (inclusive) and `start_to` (exclusive) are instants: the browser computes them, so a
"day" is the user's local day. They must include a time zone, here and on the hike lists.

- `GET /stats/me?start_from=&start_to=` → `Totals`
- `GET /stats/groups/{id}/summary` → `Totals`, without filters. Any user who can see the group,
  so this is what non-members of a public group see.
- `GET /stats/groups/{id}?start_from=&start_to=` → members only:
  `{totals: Totals, attendees: [{user_id, guest_id, name, totals: Totals}]}`
