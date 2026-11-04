import { useQuery } from "@tanstack/react-query";
import { api, withQuery } from "../../lib/api";
import type { PeriodRange } from "./period";

export interface Totals {
  hike_count: number;
  total_distance_m: number;
  total_elevation_gain_m: number;
  total_duration_s: number;
  average_duration_s: number;
}

export interface AttendeeTotals {
  user_id: string | null;
  guest_id: string | null;
  name: string;
  totals: Totals;
}

export interface GroupStats {
  totals: Totals;
  attendees: AttendeeTotals[];
}

/** Hike mutations invalidate this key, see ../hikes/api.ts. */
const STATS_KEY = "stats";

export function useMyStats(range: PeriodRange) {
  const url = withQuery("/stats/me", { ...range });
  return useQuery({
    queryKey: [STATS_KEY, url],
    queryFn: () => api.get<Totals>(url),
  });
}

export function useGroupStats(groupId: string, range: PeriodRange) {
  const url = withQuery(`/stats/groups/${groupId}`, { ...range });
  return useQuery({
    queryKey: [STATS_KEY, url],
    queryFn: () => api.get<GroupStats>(url),
  });
}

export function useGroupSummary(groupId: string) {
  const url = `/stats/groups/${groupId}/summary`;
  return useQuery({
    queryKey: [STATS_KEY, url],
    queryFn: () => api.get<Totals>(url),
  });
}
