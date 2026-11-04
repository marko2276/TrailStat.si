import { ApiClient, expect, test, unique, uniqueEmail } from "./helpers";

/**
 * The hikes feature has its own small types for what it reads from trails and groups, and features
 * were built against each other's mocks. These are the fields the frontend relies on, read from
 * the real API. See frontend/src/features/hikes/api.ts and docs/api.md.
 */
test("the real API returns what the features' types say", async () => {
  const a = await ApiClient.as(uniqueEmail("contract"), "Anna");
  const name = unique("Contract group");
  const group = await a.createGroup(name);
  const guest = await a.post<{ id: string }>(`/groups/${group.id}/guests`, { nickname: "Metka" });
  const trailName = unique("Contract trail");
  const trail = await a.createTrail(trailName, 5, 100, { visibility: "group", group_id: group.id });
  const hike = await a.createHike({
    trail_id: trail.id,
    start_at: "2026-02-14T09:00:00+01:00",
    duration_s: 3600,
    group_id: group.id,
    attendee_user_ids: [a.id],
    attendee_guest_ids: [guest.id],
  });

  const trails = await a.get<{ items: unknown[]; total: number; limit: number; offset: number }>(
    `/trails?q=${encodeURIComponent(trailName)}&include_archived=false&limit=200`,
  );
  expect(trails).toMatchObject({ total: 1, limit: 200, offset: 0 });
  expect(trails.items[0]).toEqual({
    id: trail.id,
    name: trailName,
    visibility: "group",
    group_id: group.id,
    owner_user_id: a.id,
    can_edit: true,
    source: "manual",
    distance_m: 5000,
    elevation_gain_m: 100,
    archived: false,
  });

  const groups = await a.get<{ items: unknown[] }>("/groups?scope=mine&limit=200");
  expect(groups.items[0]).toEqual({
    id: group.id,
    name,
    description: `About ${name}`,
    visibility: "private",
    is_member: true,
    is_admin: true,
    member_count: 1,
  });
  expect(await a.get(`/groups/${group.id}`)).toEqual(groups.items[0]);
  expect(await a.get(`/groups/${group.id}/members`)).toEqual({
    items: [{ user_id: a.id, display_name: "Anna", role: "admin" }],
  });
  expect(await a.get(`/groups/${group.id}/guests`)).toEqual({
    items: [{ id: guest.id, nickname: "Metka" }],
  });

  const expectedHike = {
    id: hike.id,
    trail: {
      id: trail.id,
      name: trailName,
      distance_m: 5000,
      elevation_gain_m: 100,
      archived: false,
    },
    group_id: group.id,
    group_name: name,
    recorded_by: a.id,
    start_at: expect.stringMatching(/^2026-02-14T08:00:00(Z|\+00:00)$/),
    duration_s: 3600,
    notes: null,
    attendees: [
      { user_id: a.id, guest_id: null, name: "Anna" },
      { user_id: null, guest_id: guest.id, name: "Metka" },
    ],
    can_edit: true,
    can_delete: true,
  };
  expect(await a.get(`/hikes/${hike.id}`)).toEqual(expectedHike);
  const mine = await a.get<{ items: unknown[] }>("/hikes?limit=20&offset=0");
  expect(mine.items[0]).toEqual(expectedHike);

  const totals = {
    hike_count: 1,
    total_distance_m: 5000,
    total_elevation_gain_m: 100,
    total_duration_s: 3600,
    average_duration_s: 3600,
  };
  expect(await a.get("/stats/me")).toEqual(totals);
  expect(await a.get(`/stats/groups/${group.id}/summary`)).toEqual(totals);
  expect(await a.get(`/stats/groups/${group.id}`)).toEqual({
    totals,
    attendees: [
      { user_id: a.id, guest_id: null, name: "Anna", totals },
      { user_id: null, guest_id: guest.id, name: "Metka", totals },
    ],
  });
});
