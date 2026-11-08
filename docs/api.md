# API contract between features

Every endpoint is under `/api` and needs `Authorization: Bearer <Hanko token>`. Lists return
`{items, total, limit, offset}` and take `limit` (default 50, maximum 200) and `offset`.
Timestamps are ISO 8601 with a time zone. Errors are `{"detail": "<code>"}`; the code is
translated by the frontend. The full, generated reference is at `/api/docs`, except in production.

429 `rate_limited` means too many attempts by this user: invitation e-mails, created and resent
together, 20 per hour; join requests 10 per hour; OpenStreetMap calls 20 per minute. The counts are
per process (`app/rate_limit.py`).

This file lists what features rely on from each other. Change it together with the code.

## Trails (`app/api/trails.py`)

`TrailSummary`:
`{id, name, visibility: "public"|"private"|"group", group_id, owner_user_id, can_edit, source: "osm"|"manual"|"file",
distance_m, elevation_gain_m|null, archived: bool}`

- `GET /trails?q=&scope=all|public|mine|group&group_id=&include_archived=false&sort=name|distance|elevation&order=asc|desc`
  → page of `TrailSummary`, only trails the user can see. `scope=mine` means created by the user.
  `include_archived` adds only the archived trails the user can edit.
- `GET /trails/{id}` → `TrailSummary` + `{description, elevation_loss_m, highest_point_m, geometry: GeoJSON|null,
  elevation_profile: [[distance_m, elevation_m], ...]|null, elevation_source: "dem"|"file"|null,
  osm_relation_id, can_edit_measurements, can_replace_route, created_at, updated_at}`

`source: "file"` is a trail whose route the user loaded, for example from a GPX or KML file read in
the browser. `elevation_source` says where its elevation figures came from: `"dem"` (the Copernicus
DEM, which needs attribution), `"file"` (the heights sent with the route), or null (typed in, or none).

An archived trail stays readable by id, for hikes that reference it. Elevation fields and the profile
are null for manual trails without those values, and for imported trails outside the elevation data.
`owner_name` and `group_name` are also part of the detail. `geometry` is a GeoJSON LineString.

Only the creator can change `visibility` or `group_id` (403 `sharing_creator_only`); the detail's `can_change_sharing` tells the UI. Every write below returns the detail. Who may edit is `can_edit`: the creator, and for group trails
also the group's admins. Others get 403, or 404 if they cannot see the trail. Trails cannot be deleted.

- `POST /trails` `{name, distance_m, elevation_gain_m, description?, highest_point_m?, visibility, group_id?}`
  → 201. `group_id` is required for group visibility, which needs membership, and refused for others.
  Instead of the measurements, a `geometry` can be sent: a route, from which distance and elevation
  are measured, making a `"file"` trail. Both together give 422 `measurements_from_route`; neither
  gives 422 `distance_m_required` or `elevation_gain_m_required`.
- `PATCH /trails/{id}` with any of those fields. Only the fields present change. Changing visibility or
  group rechecks membership and the name. Distance and elevation of imported trails cannot be changed
  (422 `osm_measurements_read_only`). Once a hike on the trail has an attendee other than the editor,
  a user or a guest, a change to `distance_m`, `elevation_gain_m` or `highest_point_m` gives
  409 `trail_measurements_in_use`, as these are in that attendee's statistics. Sending the current
  value is no change. The detail's `can_edit_measurements` tells the UI. `elevation_loss_m` is never
  writable: it comes from the elevation data.
- `PATCH /trails/{id}` `{geometry}` loads a new route into a manual or file trail, which becomes a
  file trail, measured from it. The same lock applies (409 `trail_measurements_in_use`). Not on
  imported trails (422 `osm_route_read_only`), not together with measurements (422
  `measurements_from_route`), and a route cannot be removed (422 `route_required`). A file trail's
  measurements can't be typed in (422 `route_measurements_read_only`). The detail's
  `can_replace_route` tells the UI.
- `POST /trails/{id}/archive`, `POST /trails/{id}/unarchive`. Doing either twice changes nothing.

Names are unique within a scope, ignoring case, including archived trails: 409 `trail_name_taken`.

Routes. A `geometry` is a GeoJSON LineString of 2 to 100,000 positions `[longitude, latitude]` or
`[longitude, latitude, height_m]`. It is simplified (GPS jitter under 3 m is dropped, at most 5,000
points are kept), and only positions are stored. Elevation comes from the DEM; where the DEM does
not cover the whole route, from the heights sent, if every point has one; otherwise there is none.
A route that never moves gives 422 `route_too_short`, one over 10,000 km 422 `route_too_long`.
Previews and saves of a route count together: 30 a minute per user (429 `rate_limited`).

- `POST /trails/route-preview` `{geometry}` → `{geometry, distance_m, elevation_gain_m,
  elevation_loss_m, highest_point_m, elevation_profile, elevation_source}`: what a trail with this
  route would get. Nothing is saved.

OpenStreetMap, through Overpass. A failing, overloaded or slow Overpass gives 503 `osm_unavailable`,
and so do more than 3 calls at a time on this server.

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
- `GET /groups/invitations/{token}`, `POST .../{token}/accept`, `POST .../{token}/decline`.
  The view has `email_matches`, and group details only if it is true. `email_verified` is false if the
  address is the invited one but not verified yet: accepting gives 403 `invitation_email_mismatch`.
  Approving a join request marks pending invitations of that address to the group as accepted, and
  removing a member revokes them, so an old link can't bring a removed member back.
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
A `PATCH` that conflicts with another change to the attendees gives 409 `hike_changed`.

The group's privacy goes with membership. For an attendee no longer in the hike's group, `GET /hikes`
and `GET /hikes/{id}` return only their own part: the trail, the time and the duration, themselves as
the only attendee, null `group_id`, `group_name`, `recorded_by` and `notes`, and false `can_edit` and
`can_delete`. Their statistics still count it.

A hike shows its trail's name and measurements to everyone who can see the hike, even if the trail has
since become invisible to them, for example after it was made private or they left its group.
`GET /trails/{id}` is then 404.

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

## Your account (`app/api/me.py`)

- `GET /me/export` → everything stored about the user, as JSON
- `DELETE /me` → removes the user's data. Hikes only they attended and their private trails go,
  unless someone else's hike refers to the trail. A last admin's group passes to its
  longest-standing member, or is deleted if nobody else is in it.
