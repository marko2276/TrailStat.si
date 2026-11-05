import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  useAcceptInvitation,
  useAddGuest,
  useCreateGroup,
  useDeleteGroup,
  useRemoveGuest,
  useRemoveMember,
} from "../features/groups/api";
import { useAddGuest as useAddGuestWhileRecording } from "../features/hikes/api";
import { useUpdateMe } from "../features/profile/api";
import { useArchiveTrail, useCreateTrail, useUpdateTrail } from "../features/trails/api";
import { AuthContext } from "../auth/AuthContext";
import { mockApi } from "../test/mockApi";

vi.mock("../auth/hanko", () => ({
  getHanko: () => new Promise(() => undefined),
  getSessionToken: () => "token",
  isHankoConfigured: true,
}));

// The keys each feature really caches this data under.
const HIKE_FORM_TRAILS = ["trails", "search", "/trails?limit=200"];
const TRAIL_LIST = ["trails", "list", "/trails?limit=25"];
const HIKE_LIST = ["hikes", "list", "/hikes?limit=20&offset=0"];
const STATS = ["stats", "/stats/me"];
const GROUP_PAGE_GUESTS = ["groups", "detail", "g1", "guests"];
const HIKE_FORM_GUESTS = ["groups", "guests", "g1"];
const HIKE_FORM_MEMBERS = ["groups", "members", "g1"];
const TRAIL_FORM_GROUPS = ["groups", "mine", "options"];
const GROUP_LIST = ["groups", "list", "mine", "", 0];
const ALL = [
  HIKE_FORM_TRAILS,
  TRAIL_LIST,
  HIKE_LIST,
  STATS,
  GROUP_PAGE_GUESTS,
  HIKE_FORM_GUESTS,
  HIKE_FORM_MEMBERS,
  TRAIL_FORM_GROUPS,
  GROUP_LIST,
];

async function staleAfter(run: () => Promise<unknown>, client: QueryClient) {
  await act(run);
  return (key: unknown[]) => client.getQueryState(key)?.isInvalidated;
}

function setup<T>(useHook: () => T) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const key of ALL) client.setQueryData(key, {});
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <AuthContext.Provider value={{ status: "authenticated", logout: async () => undefined }}>
        {children}
      </AuthContext.Provider>
    </QueryClientProvider>
  );
  return { client, hook: renderHook(useHook, { wrapper }).result };
}

const trail = { id: "t1", name: "Krn" };

describe("a change in one feature refreshes what the others show", () => {
  it.each([
    ["creating", "POST /api/trails", () => useCreateTrail(), {}],
    ["editing", "PATCH /api/trails/t1", () => useUpdateTrail("t1"), { name: "New" }],
    ["archiving", "POST /api/trails/t1/archive", () => useArchiveTrail("t1"), true],
  ] as const)(
    "%s a trail refreshes the hike form, hikes and statistics",
    async (_, key, hook, input) => {
      mockApi({ [key]: trail });
      const { client, hook: result } = setup(
        hook as () => { mutateAsync: (v: never) => Promise<unknown> },
      );
      const stale = await staleAfter(() => result.current.mutateAsync(input as never), client);
      expect(stale(HIKE_FORM_TRAILS)).toBe(true);
      expect(stale(TRAIL_LIST)).toBe(true);
      expect(stale(HIKE_LIST)).toBe(true);
      expect(stale(STATS)).toBe(true);
    },
  );

  it("deleting a group refreshes hikes, trails, statistics and all lists of groups", async () => {
    mockApi({ "DELETE /api/groups/g1": { status: 204 } });
    const { client, hook } = setup(() => useDeleteGroup("g1"));
    const stale = await staleAfter(() => hook.current.mutateAsync(), client);
    for (const key of [
      HIKE_LIST,
      STATS,
      TRAIL_LIST,
      HIKE_FORM_TRAILS,
      TRAIL_FORM_GROUPS,
      GROUP_LIST,
    ]) {
      expect(stale(key), String(key)).toBe(true);
    }
  });

  it("a guest added on the group's page reaches the hike form", async () => {
    mockApi({ "POST /api/groups/g1/guests": { id: "x", nickname: "Metka" } });
    const { client, hook } = setup(() => useAddGuest("g1"));
    const stale = await staleAfter(() => hook.current.mutateAsync("Metka"), client);
    expect(stale(HIKE_FORM_GUESTS)).toBe(true);
    expect(stale(GROUP_PAGE_GUESTS)).toBe(true);
  });

  it("a guest added while recording reaches the group's page", async () => {
    mockApi({ "POST /api/groups/g1/guests": { id: "x", nickname: "Metka" } });
    const { client, hook } = setup(() => useAddGuestWhileRecording("g1"));
    const stale = await staleAfter(() => hook.current.mutateAsync("Metka"), client);
    expect(stale(GROUP_PAGE_GUESTS)).toBe(true);
    expect(stale(HIKE_FORM_GUESTS)).toBe(true);
  });

  it("removing a guest refreshes hikes and statistics, as their attendance goes too", async () => {
    mockApi({ "DELETE /api/groups/g1/guests/x": { status: 204 } });
    const { client, hook } = setup(() => useRemoveGuest("g1"));
    const stale = await staleAfter(() => hook.current.mutateAsync("x"), client);
    expect(stale(HIKE_LIST)).toBe(true);
    expect(stale(STATS)).toBe(true);
  });

  it("removing a member refreshes the hike form's list of members", async () => {
    mockApi({ "DELETE /api/groups/g1/members/u": { status: 204 } });
    const { client, hook } = setup(() => useRemoveMember("g1"));
    const stale = await staleAfter(() => hook.current.mutateAsync("u"), client);
    expect(stale(HIKE_FORM_MEMBERS)).toBe(true);
  });

  it("a new group reaches the trail form's list of groups", async () => {
    mockApi({ "POST /api/groups": { id: "g2" } });
    const { client, hook } = setup(() => useCreateGroup());
    const stale = await staleAfter(
      () => hook.current.mutateAsync({ name: "New", description: null, visibility: "private" }),
      client,
    );
    expect(stale(TRAIL_FORM_GROUPS)).toBe(true);
  });

  it("accepting an invitation shows the trails shared with the group", async () => {
    mockApi({ "POST /api/groups/invitations/tok/accept": { id: "g1" } });
    const { client, hook } = setup(() => useAcceptInvitation("tok"));
    const stale = await staleAfter(() => hook.current.mutateAsync(), client);
    expect(stale(TRAIL_LIST)).toBe(true);
    expect(stale(HIKE_FORM_TRAILS)).toBe(true);
  });

  it("changing one's name refreshes hikes and members, but changing language doesn't", async () => {
    mockApi({ "PATCH /api/me": { id: "u", display_name: "New" } });
    const first = setup(() => useUpdateMe());
    const unchanged = await staleAfter(
      () => first.hook.current.mutateAsync({ locale: "sl" }),
      first.client,
    );
    expect(unchanged(HIKE_LIST)).toBe(false);
    const second = setup(() => useUpdateMe());
    const stale = await staleAfter(
      () => second.hook.current.mutateAsync({ display_name: "New" }),
      second.client,
    );
    expect(stale(HIKE_LIST)).toBe(true);
    expect(stale(HIKE_FORM_MEMBERS)).toBe(true);
  });
});
