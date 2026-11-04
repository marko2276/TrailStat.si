import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, withQuery } from "../../lib/api";
import type { Page } from "../../lib/api";

export const PAGE_SIZE = 20;

export interface HikeAttendee {
  user_id: string | null;
  guest_id: string | null;
  name: string;
}

export interface Hike {
  id: string;
  trail: {
    id: string;
    name: string;
    distance_m: number;
    elevation_gain_m: number | null;
    archived: boolean;
  };
  group_id: string | null;
  group_name: string | null;
  recorded_by: string | null;
  start_at: string;
  duration_s: number;
  notes: string | null;
  attendees: HikeAttendee[];
  can_edit: boolean;
  can_delete: boolean;
}

export interface HikeCreate {
  trail_id: string;
  start_at: string;
  duration_s: number;
  notes: string | null;
  group_id: string | null;
  attendee_user_ids: string[];
  attendee_guest_ids: string[];
}

export type HikeUpdate = Partial<Omit<HikeCreate, "group_id">>;

export interface Period {
  start_from?: string;
  start_to?: string;
}

/** The fields of other features' resources that recording a hike needs. See docs/api.md. */
export interface TrailOption {
  id: string;
  name: string;
  visibility: "public" | "private" | "group";
  group_id: string | null;
  distance_m: number;
  elevation_gain_m: number | null;
  archived: boolean;
}

export interface GroupOption {
  id: string;
  name: string;
  is_member: boolean;
}

export interface GroupMember {
  user_id: string;
  display_name: string;
}

export interface GroupGuest {
  id: string;
  nickname: string;
}

const HIKES_KEY = "hikes";
/** Statistics are derived from hikes, so changing a hike must refresh them as well. */
const STATS_KEY = "stats";

interface ListOptions extends Period {
  page?: number;
  limit?: number;
}

function listQuery({ start_from, start_to, page = 0, limit = PAGE_SIZE }: ListOptions) {
  return { start_from, start_to, limit, offset: page * limit };
}

/** The hikes of a group, or the signed-in user's own when `groupId` is null. */
export function useHikes(groupId: string | null, options: ListOptions = {}) {
  const path = groupId ? `/groups/${groupId}/hikes` : "/hikes";
  const url = withQuery(path, listQuery(options));
  return useQuery({
    queryKey: [HIKES_KEY, "list", url],
    queryFn: () => api.get<Page<Hike>>(url),
  });
}

export function useHike(id: string) {
  return useQuery({
    queryKey: [HIKES_KEY, "detail", id],
    queryFn: () => api.get<Hike>(`/hikes/${id}`),
  });
}

function useInvalidateHikes() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: [HIKES_KEY] }),
      queryClient.invalidateQueries({ queryKey: [STATS_KEY] }),
    ]);
}

export function useCreateHike() {
  const invalidate = useInvalidateHikes();
  return useMutation({
    mutationFn: (hike: HikeCreate) => api.post<Hike>("/hikes", hike),
    onSuccess: invalidate,
  });
}

export function useUpdateHike(id: string) {
  const invalidate = useInvalidateHikes();
  return useMutation({
    mutationFn: (update: HikeUpdate) => api.patch<Hike>(`/hikes/${id}`, update),
    onSuccess: invalidate,
  });
}

export function useDeleteHike(id: string) {
  const invalidate = useInvalidateHikes();
  return useMutation({
    mutationFn: () => api.delete(`/hikes/${id}`),
    onSuccess: invalidate,
  });
}

export function useTrailSearch(query: string) {
  const url = withQuery("/trails", { q: query, include_archived: false, limit: PAGE_SIZE });
  return useQuery({
    queryKey: ["trails", "search", url],
    queryFn: () => api.get<Page<TrailOption>>(url),
  });
}

export function useMyGroups() {
  const url = withQuery("/groups", { scope: "mine", limit: 200 });
  return useQuery({
    queryKey: ["groups", "list", url],
    queryFn: () => api.get<Page<GroupOption>>(url),
  });
}

export function useGroup(id: string | null) {
  return useQuery({
    queryKey: ["groups", "detail", id],
    queryFn: () => api.get<GroupOption>(`/groups/${id}`),
    enabled: id !== null,
  });
}

export function useGroupMembers(groupId: string | null) {
  return useQuery({
    queryKey: ["groups", "members", groupId],
    queryFn: () => api.get<{ items: GroupMember[] }>(`/groups/${groupId}/members`),
    enabled: groupId !== null,
  });
}

export function useGroupGuests(groupId: string | null) {
  return useQuery({
    queryKey: ["groups", "guests", groupId],
    queryFn: () => api.get<{ items: GroupGuest[] }>(`/groups/${groupId}/guests`),
    enabled: groupId !== null,
  });
}

export function useAddGuest(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (nickname: string) =>
      api.post<GroupGuest>(`/groups/${groupId}/guests`, { nickname }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["groups", "guests", groupId] }),
  });
}
