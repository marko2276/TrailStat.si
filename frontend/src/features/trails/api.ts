import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, withQuery } from "../../lib/api";
import type { Page } from "../../lib/api";

export type Visibility = "public" | "private" | "group";
export type Scope = "all" | "public" | "mine" | "group";
export type SortField = "name" | "distance" | "elevation";
export type SortOrder = "asc" | "desc";

export interface LineString {
  type: "LineString";
  coordinates: [number, number][];
}

export interface TrailSummary {
  id: string;
  name: string;
  visibility: Visibility;
  group_id: string | null;
  owner_user_id: string | null;
  can_edit: boolean;
  source: "osm" | "manual";
  distance_m: number;
  /** null for imported trails outside the available elevation data */
  elevation_gain_m: number | null;
  archived: boolean;
}

export interface TrailDetail extends TrailSummary {
  can_change_sharing: boolean;
  owner_name: string | null;
  group_name: string | null;
  description: string | null;
  elevation_loss_m: number | null;
  highest_point_m: number | null;
  geometry: LineString | null;
  /** [distance_m, elevation_m] pairs */
  elevation_profile: [number, number][] | null;
  osm_relation_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface TrailListParams {
  q: string;
  scope: Scope;
  includeArchived: boolean;
  sort: SortField;
  order: SortOrder;
  offset: number;
}

export const PAGE_SIZE = 25;

export interface Sharing {
  visibility: Visibility;
  group_id?: string;
}

export interface TrailCreate extends Sharing {
  name: string;
  description: string | null;
  distance_m: number;
  elevation_gain_m: number;
  highest_point_m: number | null;
}

export type TrailUpdate = Partial<TrailCreate>;

export interface OsmRoute {
  relation_id: number;
  name: string | null;
  ref: string | null;
  network: string | null;
  start_name: string | null;
  end_name: string | null;
}

export interface OsmPreview {
  relation_id: number;
  name: string | null;
  geometry: LineString;
  distance_m: number;
  /** false if gaps or branches left part of the route out of the geometry */
  complete: boolean;
  member_length_m: number;
}

export interface OsmImport extends Sharing {
  relation_id: number;
  name?: string;
}

export interface GroupOption {
  id: string;
  name: string;
}

const TRAILS_KEY = ["trails"];

/** Leaves out the defaults, to keep requests readable. */
export function useTrails({ q, scope, includeArchived, sort, order, offset }: TrailListParams) {
  const path = withQuery("/trails", {
    q: q.trim(),
    scope: scope === "all" ? undefined : scope,
    include_archived: includeArchived ? true : undefined,
    sort: sort === "name" ? undefined : sort,
    order: order === "asc" ? undefined : order,
    limit: PAGE_SIZE,
    offset: offset || undefined,
  });
  return useQuery({
    queryKey: [...TRAILS_KEY, "list", path],
    queryFn: () => api.get<Page<TrailSummary>>(path),
    placeholderData: keepPreviousData,
  });
}

export function useTrail(id: string) {
  return useQuery({
    queryKey: [...TRAILS_KEY, "detail", id],
    queryFn: () => api.get<TrailDetail>(`/trails/${id}`),
  });
}

function useTrailMutation<Input>(mutationFn: (input: Input) => Promise<TrailDetail>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (trail) => {
      queryClient.setQueryData([...TRAILS_KEY, "detail", trail.id], trail);
      void queryClient.invalidateQueries({ queryKey: [...TRAILS_KEY, "list"] });
    },
  });
}

export function useCreateTrail() {
  return useTrailMutation((trail: TrailCreate) => api.post<TrailDetail>("/trails", trail));
}

export function useUpdateTrail(id: string) {
  return useTrailMutation((changes: TrailUpdate) =>
    api.patch<TrailDetail>(`/trails/${id}`, changes),
  );
}

export function useArchiveTrail(id: string) {
  return useTrailMutation((archived: boolean) =>
    api.post<TrailDetail>(`/trails/${id}/${archived ? "archive" : "unarchive"}`),
  );
}

export function useImportOsmRoute() {
  return useTrailMutation((route: OsmImport) => api.post<TrailDetail>("/trails/osm/import", route));
}

// Overpass is a shared public service, so nothing here repeats a request on its own.
const gentleOnOverpass = {
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  staleTime: 5 * 60 * 1000,
} as const;

export function useOsmSearch(search: { q: string; bbox: string | null } | null) {
  const path = search && withQuery("/trails/osm/search", { q: search.q, bbox: search.bbox });
  return useQuery({
    queryKey: ["osm", "search", path],
    queryFn: () => api.get<Page<OsmRoute>>(path!),
    enabled: path !== null,
    ...gentleOnOverpass,
  });
}

export function useOsmPreview(relationId: number | null) {
  return useQuery({
    queryKey: ["osm", "route", relationId],
    queryFn: () => api.get<OsmPreview>(`/trails/osm/${relationId}`),
    enabled: relationId !== null,
    ...gentleOnOverpass,
  });
}

export function useMyGroups(enabled: boolean) {
  return useQuery({
    queryKey: ["groups", "mine", "options"],
    queryFn: () => api.get<Page<GroupOption>>("/groups?scope=mine&limit=200"),
    enabled,
  });
}
