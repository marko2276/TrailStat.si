import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, withQuery } from "../../lib/api";
import type { Page } from "../../lib/api";
import { invalidateSharedData } from "../../lib/sharedData";

export type GroupVisibility = "public" | "private";
export type GroupRole = "admin" | "member";
export type GroupScope = "mine" | "public";

export interface Group {
  id: string;
  name: string;
  /** null for non-members */
  description: string | null;
  visibility: GroupVisibility;
  is_member: boolean;
  is_admin: boolean;
  /** null for non-members */
  member_count: number | null;
}

export interface GroupInput {
  name: string;
  description: string | null;
  visibility: GroupVisibility;
}

export interface Member {
  user_id: string;
  display_name: string;
  role: GroupRole;
}

export interface Guest {
  id: string;
  nickname: string;
}

export interface Invitation {
  id: string;
  email: string;
  status: string;
  expires_at: string;
  expired: boolean;
  created_at: string;
}

export interface InvitationView {
  email_matches: boolean;
  group_id: string | null;
  group_name: string | null;
  inviter_name: string | null;
  expires_at: string;
}

export interface JoinRequest {
  id: string;
  user_id: string;
  display_name: string;
  status: string;
  created_at: string;
}

export interface MyJoinRequest {
  id: string | null;
  status: "none" | "pending" | "approved" | "rejected";
  created_at: string | null;
}

export interface Totals {
  hike_count: number;
  total_distance_m: number;
  total_elevation_gain_m: number;
  total_duration_s: number;
  average_duration_s: number | null;
}

/** Enough for the panels of one group. */
const PANEL_LIMIT = 200;
export const GROUPS_PAGE_SIZE = 20;

const LISTS_KEY = ["groups", "list"];
const groupKey = (id: string) => ["groups", "detail", id];

export function useGroups(scope: GroupScope, q: string, offset: number) {
  return useQuery({
    queryKey: [...LISTS_KEY, scope, q, offset],
    queryFn: () =>
      api.get<Page<Group>>(
        withQuery("/groups", { scope, q, limit: GROUPS_PAGE_SIZE, offset: offset }),
      ),
    placeholderData: keepPreviousData,
  });
}

export function useGroup(id: string) {
  return useQuery({
    queryKey: groupKey(id),
    queryFn: () => api.get<Group>(`/groups/${id}`),
  });
}

export function useMembers(id: string) {
  return useQuery({
    queryKey: [...groupKey(id), "members"],
    queryFn: () => api.get<{ items: Member[] }>(`/groups/${id}/members`),
  });
}

export function useGuests(id: string) {
  return useQuery({
    queryKey: [...groupKey(id), "guests"],
    queryFn: () => api.get<{ items: Guest[] }>(`/groups/${id}/guests`),
  });
}

export function useInvitations(id: string) {
  return useQuery({
    queryKey: [...groupKey(id), "invitations"],
    queryFn: () =>
      api.get<Page<Invitation>>(withQuery(`/groups/${id}/invitations`, { limit: PANEL_LIMIT })),
  });
}

export function useJoinRequests(id: string) {
  return useQuery({
    queryKey: [...groupKey(id), "join-requests"],
    queryFn: () =>
      api.get<Page<JoinRequest>>(withQuery(`/groups/${id}/join-requests`, { limit: PANEL_LIMIT })),
  });
}

export function useMyJoinRequest(id: string) {
  return useQuery({
    queryKey: [...groupKey(id), "my-join-request"],
    queryFn: () => api.get<MyJoinRequest>(`/groups/${id}/join-requests/mine`),
  });
}

export function useGroupSummary(id: string) {
  return useQuery({
    queryKey: [...groupKey(id), "summary"],
    queryFn: () => api.get<Totals>(`/stats/groups/${id}/summary`),
  });
}

export function useInvitationView(token: string, enabled: boolean) {
  return useQuery({
    queryKey: ["groups", "invitation", token],
    queryFn: () => api.get<InvitationView>(`/groups/invitations/${encodeURIComponent(token)}`),
    enabled,
    refetchOnWindowFocus: false,
  });
}

/** A change to one group: other features show its name, members and guests too. */
function useGroupChange<V, R>(mutationFn: (variables: V) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => invalidateSharedData(queryClient),
  });
}

/** After this the page's own data is gone or forbidden: forget it instead of refetching. */
function useGroupExit(groupId: string, mutationFn: () => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: groupKey(groupId) });
      await invalidateSharedData(queryClient);
    },
  });
}

export function useCreateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: GroupInput) => api.post<Group>("/groups", input),
    onSuccess: () => invalidateSharedData(queryClient),
  });
}

export function useUpdateGroup(id: string) {
  return useGroupChange((input: GroupInput) => api.patch<Group>(`/groups/${id}`, input));
}

export function useDeleteGroup(id: string) {
  return useGroupExit(id, () => api.delete(`/groups/${id}`));
}

export function useLeaveGroup(id: string) {
  return useGroupExit(id, () => api.post<void>(`/groups/${id}/leave`));
}

export function useSetMemberRole(id: string) {
  return useGroupChange(({ userId, role }: { userId: string; role: GroupRole }) =>
    api.patch<Member>(`/groups/${id}/members/${userId}`, { role }),
  );
}

export function useRemoveMember(id: string) {
  return useGroupChange((userId: string) => api.delete(`/groups/${id}/members/${userId}`));
}

export function useAddGuest(id: string) {
  return useGroupChange((nickname: string) =>
    api.post<Guest>(`/groups/${id}/guests`, { nickname }),
  );
}

export function useRenameGuest(id: string) {
  return useGroupChange(({ guestId, nickname }: { guestId: string; nickname: string }) =>
    api.patch<Guest>(`/groups/${id}/guests/${guestId}`, { nickname }),
  );
}

export function useRemoveGuest(id: string) {
  return useGroupChange((guestId: string) => api.delete(`/groups/${id}/guests/${guestId}`));
}

export function useInvite(id: string) {
  return useGroupChange((email: string) =>
    api.post<Invitation>(`/groups/${id}/invitations`, { email }),
  );
}

export function useResendInvitation(id: string) {
  return useGroupChange((invitationId: string) =>
    api.post<Invitation>(`/groups/${id}/invitations/${invitationId}/resend`),
  );
}

export function useRevokeInvitation(id: string) {
  return useGroupChange((invitationId: string) =>
    api.delete(`/groups/${id}/invitations/${invitationId}`),
  );
}

export function useRequestToJoin(id: string) {
  return useGroupChange(() => api.post<JoinRequest>(`/groups/${id}/join-requests`));
}

export function useCancelJoinRequest(id: string) {
  return useGroupChange(() => api.delete(`/groups/${id}/join-requests/mine`));
}

export function useDecideJoinRequest(id: string) {
  return useGroupChange(
    ({ requestId, decision }: { requestId: string; decision: "approve" | "reject" }) =>
      api.post<JoinRequest>(`/groups/${id}/join-requests/${requestId}/${decision}`),
  );
}

export function useAcceptInvitation(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<Group>(`/groups/invitations/${encodeURIComponent(token)}/accept`),
    onSuccess: () => invalidateSharedData(queryClient),
  });
}

export function useDeclineInvitation(token: string) {
  return useMutation({
    mutationFn: () => api.post<void>(`/groups/invitations/${encodeURIComponent(token)}/decline`),
  });
}
