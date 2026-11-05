import type { Page } from "../../lib/api";
import type { Hike, TrailOption } from "./api";

/** Test data. */
export const me = {
  id: "me",
  email: "marko@example.com",
  display_name: "Marko",
  country: null,
  city: null,
  avatar_url: null,
  locale: "en",
};

export function makeHike(fields: Partial<Hike> = {}): Hike {
  return {
    id: "h1",
    trail: {
      id: "t1",
      name: "Triglav",
      distance_m: 12_500,
      elevation_gain_m: 1_400,
      archived: false,
    },
    group_id: null,
    group_name: null,
    recorded_by: "me",
    start_at: "2024-07-01T07:30:00Z",
    duration_s: 5400,
    notes: null,
    attendees: [{ user_id: "me", guest_id: null, name: "Marko" }],
    can_edit: true,
    can_delete: true,
    ...fields,
  };
}

export function makeTrail(fields: Partial<TrailOption> = {}): TrailOption {
  return {
    id: "t1",
    name: "Triglav",
    visibility: "public",
    group_id: null,
    distance_m: 12_500,
    elevation_gain_m: 1_400,
    archived: false,
    ...fields,
  };
}

export function page<T>(items: T[], total = items.length): Page<T> {
  return { items, total, limit: 20, offset: 0 };
}
