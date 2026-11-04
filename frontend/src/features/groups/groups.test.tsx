import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { mockApi } from "../../test/mockApi";
import { render } from "../../test/render";
import { GroupActivity } from "./GroupActivity";
import { GroupCreatePage } from "./GroupCreatePage";
import { GroupDetailPage } from "./GroupDetailPage";
import { GroupsPage } from "./GroupsPage";

vi.mock("../../auth/hanko", () => ({
  getHanko: () => new Promise(() => undefined),
  getSessionToken: () => "token",
  isHankoConfigured: true,
}));

const page = (items: unknown[], total = items.length) => ({ items, total, limit: 20, offset: 0 });

const base = {
  id: "g1",
  name: "Hikers",
  description: "We walk.",
  visibility: "public",
  is_member: true,
  is_admin: false,
  member_count: 2,
};
const adminGroup = { ...base, is_admin: true };
const outsiderGroup = { ...base, description: null, member_count: null, is_member: false };

const me = { id: "u1", email: "me@example.com", display_name: "Me" };
const members = {
  items: [
    { user_id: "u1", display_name: "Me", role: "admin" },
    { user_id: "u2", display_name: "Bor", role: "member" },
  ],
};
const guests = { items: [{ id: "x1", nickname: "Uncle Bob" }] };

const memberReplies = {
  "GET /api/me": me,
  "GET /api/groups/g1": base,
  "GET /api/groups/g1/members": members,
  "GET /api/groups/g1/guests": guests,
};
const adminReplies = {
  ...memberReplies,
  "GET /api/groups/g1": adminGroup,
  "GET /api/groups/g1/invitations?limit=200": page([
    {
      id: "i1",
      email: "new@example.com",
      status: "pending",
      expires_at: "2030-01-08T10:00:00Z",
      expired: false,
      created_at: "2030-01-01T10:00:00Z",
    },
  ]),
  "GET /api/groups/g1/join-requests?limit=200": page([
    {
      id: "r1",
      user_id: "u9",
      display_name: "Requester",
      status: "pending",
      created_at: "2030-01-01T10:00:00Z",
    },
  ]),
};

/** Written out: mockApi would take the body's own `status` field for an HTTP status. */
const myRequest = (status: string) => ({
  status: 200,
  body: { id: status === "none" ? null : "r1", status, created_at: null },
});

function renderDetail() {
  return render(
    <Routes>
      <Route path="/groups" element={<p>List page</p>} />
      <Route path="/groups/:id" element={<GroupDetailPage />} />
    </Routes>,
    { route: "/groups/g1" },
  );
}

function bodiesOf(api: ReturnType<typeof mockApi>, key: string) {
  return api.requests.filter((request) => request.key === key);
}

describe("GroupsPage", () => {
  const replies = {
    "GET /api/groups?scope=mine&limit=20&offset=0": page([adminGroup]),
    "GET /api/groups?scope=public&limit=20&offset=0": page([
      { ...outsiderGroup, id: "g2", name: "Open one" },
    ]),
  };

  it("shows my groups with my role, and public groups", async () => {
    mockApi(replies);
    render(<GroupsPage />);

    const mine = (await screen.findByRole("link", { name: "Hikers" })).closest("li")!;
    expect(mine.textContent).toContain("Admin");
    const open = (await screen.findByRole("link", { name: "Open one" })).closest("li")!;
    expect(open.textContent).not.toContain("Admin");
    expect(open.textContent).not.toContain("Member");
    expect(screen.getByRole("link", { name: "Open one" }).getAttribute("href")).toBe("/groups/g2");
  });

  it("explains when there is nothing to show", async () => {
    mockApi({
      "GET /api/groups?scope=mine&limit=20&offset=0": page([]),
      "GET /api/groups?scope=public&limit=20&offset=0": page([]),
    });
    render(<GroupsPage />);

    expect(await screen.findByText(/You are not in any group yet/)).toBeTruthy();
    expect(await screen.findByText("There are no public groups yet.")).toBeTruthy();
  });

  it("searches public groups by name", async () => {
    const api = mockApi({
      ...replies,
      "GET /api/groups?scope=public&q=goat&limit=20&offset=0": page([]),
    });
    render(<GroupsPage />);

    await userEvent.type(await screen.findByLabelText("Search by name"), "goat");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("No public group matches your search.")).toBeTruthy();
    expect(api.requests.map((request) => request.key)).toContain(
      "GET /api/groups?scope=public&q=goat&limit=20&offset=0",
    );
  });

  it("pages through long lists", async () => {
    const api = mockApi({
      "GET /api/groups?scope=mine&limit=20&offset=0": page([]),
      "GET /api/groups?scope=public&limit=20&offset=0": page(
        [{ ...outsiderGroup, name: "First page" }],
        25,
      ),
      "GET /api/groups?scope=public&limit=20&offset=20": page(
        [{ ...outsiderGroup, name: "Second page" }],
        25,
      ),
    });
    render(<GroupsPage />);

    await screen.findByText("First page");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByText("Second page")).toBeTruthy();
    expect(api.requests.at(-1)?.key).toContain("offset=20");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Next" }).disabled).toBe(true);
  });

  it("shows an error when the list cannot be loaded", async () => {
    mockApi({
      "GET /api/groups?scope=mine&limit=20&offset=0": { status: 500, body: { detail: "x" } },
      "GET /api/groups?scope=public&limit=20&offset=0": page([]),
    });
    render(<GroupsPage />);

    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong");
  });
});

describe("GroupCreatePage", () => {
  function renderCreate() {
    return render(
      <Routes>
        <Route path="/groups/new" element={<GroupCreatePage />} />
        <Route path="/groups/:id" element={<p>Group page</p>} />
      </Routes>,
      { route: "/groups/new" },
    );
  }

  it("creates a group and opens it", async () => {
    const api = mockApi({ "POST /api/groups": { status: 201, body: adminGroup } });
    renderCreate();

    await userEvent.type(screen.getByLabelText("Name"), "Hikers");
    await userEvent.type(screen.getByLabelText("Description"), "We walk.");
    await userEvent.selectOptions(screen.getByLabelText("Visibility"), "public");
    await userEvent.click(screen.getByRole("button", { name: "Create group" }));

    expect(await screen.findByText("Group page")).toBeTruthy();
    expect(api.bodyOf("POST /api/groups")).toEqual({
      name: "Hikers",
      description: "We walk.",
      visibility: "public",
    });
  });

  it("is private by default and explains what that means", () => {
    renderCreate();

    expect(screen.getByLabelText<HTMLSelectElement>("Visibility").value).toBe("private");
    expect(screen.getByText(/Only members can see the group/)).toBeTruthy();
  });

  it("shows the backend's validation error", async () => {
    mockApi({ "POST /api/groups": { status: 422, body: { detail: "group_name_required" } } });
    renderCreate();

    await userEvent.type(screen.getByLabelText("Name"), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Create group" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Enter a name for the group.");
  });
});

describe("GroupDetailPage for a non-member", () => {
  const replies = {
    "GET /api/groups/g1": outsiderGroup,
    "GET /api/groups/g1/join-requests/mine": myRequest("none"),
    "GET /api/stats/groups/g1/summary": {
      hike_count: 12,
      total_distance_m: 34500,
      total_elevation_gain_m: 2100,
      total_duration_s: 7200,
      average_duration_s: 600,
    },
  };

  it("shows only the name, totals and the way in", async () => {
    const api = mockApi(replies);
    renderDetail();

    expect(await screen.findByRole("heading", { name: "Hikers" })).toBeTruthy();
    expect(await screen.findByText("12")).toBeTruthy();
    expect(screen.getByText("34.5 km")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Ask to join" })).toBeTruthy();

    for (const hidden of ["Members", "Guests", "Leave group", "Delete group", "Group hikes"]) {
      expect(screen.queryByText(hidden)).toBeNull();
    }
    const asked = api.requests.map((request) => request.key);
    expect(asked).not.toContain("GET /api/groups/g1/members");
    expect(asked).not.toContain("GET /api/groups/g1/guests");
  });

  it("still works when the totals fail", async () => {
    mockApi({
      ...replies,
      "GET /api/stats/groups/g1/summary": { status: 500, body: { detail: "x" } },
    });
    renderDetail();

    expect(await screen.findByText("The totals are not available right now.")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Ask to join" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends a join request", async () => {
    const api = mockApi({
      ...replies,
      "POST /api/groups/g1/join-requests": { status: 201, body: { id: "r1" } },
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Ask to join" }));

    await waitFor(() => expect(bodiesOf(api, "POST /api/groups/g1/join-requests")).toHaveLength(1));
  });

  it("shows a pending request, which can be cancelled", async () => {
    const api = mockApi({
      ...replies,
      "GET /api/groups/g1/join-requests/mine": myRequest("pending"),
      "DELETE /api/groups/g1/join-requests/mine": { status: 204 },
    });
    renderDetail();

    expect(await screen.findByText(/waiting for an admin/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask to join" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Cancel request" }));

    await waitFor(() =>
      expect(bodiesOf(api, "DELETE /api/groups/g1/join-requests/mine")).toHaveLength(1),
    );
  });

  it("shows a rejected request, and lets the user ask again", async () => {
    mockApi({
      ...replies,
      "GET /api/groups/g1/join-requests/mine": myRequest("rejected"),
    });
    renderDetail();

    expect(await screen.findByText("Your request was rejected.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask again" })).toBeTruthy();
  });

  it("shows an error when the request fails", async () => {
    mockApi({
      ...replies,
      "POST /api/groups/g1/join-requests": {
        status: 409,
        body: { detail: "join_request_pending" },
      },
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Ask to join" }));

    expect((await screen.findByRole("alert")).textContent).toContain("already asked");
  });

  it("reports a group that does not exist or is private", async () => {
    mockApi({ "GET /api/groups/g1": { status: 404, body: { detail: "not_found" } } });
    renderDetail();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "This group does not exist or you cannot see it.",
    );
  });
});

describe("GroupDetailPage for a plain member", () => {
  it("shows the group without admin controls", async () => {
    const api = mockApi(memberReplies);
    renderDetail();

    expect(await screen.findByText("We walk.")).toBeTruthy();
    expect(screen.getByText("Members: 2")).toBeTruthy();
    expect(await screen.findByText("Bor")).toBeTruthy();
    expect(await screen.findByText("Uncle Bob")).toBeTruthy();

    for (const hidden of [
      "Make admin",
      "Remove admin role",
      "Remove",
      "Rename",
      "Delete group",
      "Edit",
    ]) {
      expect(screen.queryByRole("button", { name: hidden })).toBeNull();
    }
    expect(screen.queryByLabelText("E-mail address")).toBeNull();
    expect(screen.queryByText("Requests to join")).toBeNull();
    const asked = api.requests.map((request) => request.key);
    expect(asked).not.toContain("GET /api/groups/g1/invitations?limit=200");
    expect(asked).not.toContain("GET /api/groups/g1/join-requests?limit=200");
  });

  it("links to the group's hikes and statistics", async () => {
    mockApi(memberReplies);
    renderDetail();

    expect((await screen.findByRole("link", { name: "Group hikes" })).getAttribute("href")).toBe(
      "/hikes?group=g1",
    );
    expect(screen.getByRole("link", { name: "Group statistics" }).getAttribute("href")).toBe(
      "/stats?group=g1",
    );
  });

  it("can add a guest", async () => {
    const api = mockApi({
      ...memberReplies,
      "POST /api/groups/g1/guests": { status: 201, body: { id: "x2", nickname: "Ana" } },
    });
    renderDetail();

    const input = await screen.findByLabelText("New guest's nickname");
    await userEvent.type(input, "Ana");
    await userEvent.click(screen.getByRole("button", { name: "Add guest" }));

    await waitFor(() =>
      expect(api.bodyOf("POST /api/groups/g1/guests")).toEqual({ nickname: "Ana" }),
    );
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  });

  it("shows when a nickname is taken", async () => {
    mockApi({
      ...memberReplies,
      "POST /api/groups/g1/guests": { status: 409, body: { detail: "guest_name_taken" } },
    });
    renderDetail();

    await userEvent.type(await screen.findByLabelText("New guest's nickname"), "uncle bob");
    await userEvent.click(screen.getByRole("button", { name: "Add guest" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "This group already has a guest with this nickname.",
    );
  });

  it("asks before leaving, and does not leave on cancel", async () => {
    const api = mockApi({ ...memberReplies, "POST /api/groups/g1/leave": { status: 204 } });
    const confirm = vi.fn();
    vi.stubGlobal("confirm", confirm);
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Leave group" }));
    expect(screen.getByText(/Your past hikes and your trails stay/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(bodiesOf(api, "POST /api/groups/g1/leave")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Leave group" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, leave" }));

    expect(await screen.findByText("List page")).toBeTruthy();
    expect(bodiesOf(api, "POST /api/groups/g1/leave")).toHaveLength(1);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("GroupDetailPage for an admin", () => {
  it("promotes a member", async () => {
    const api = mockApi({
      ...adminReplies,
      "PATCH /api/groups/g1/members/u2": { user_id: "u2", display_name: "Bor", role: "admin" },
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Make admin" }));

    await waitFor(() =>
      expect(api.bodyOf("PATCH /api/groups/g1/members/u2")).toEqual({ role: "admin" }),
    );
  });

  it("explains that the last admin cannot step down", async () => {
    mockApi({
      ...adminReplies,
      "PATCH /api/groups/g1/members/u1": { status: 409, body: { detail: "last_admin" } },
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Remove admin role" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "A group must have at least one admin",
    );
  });

  it("explains that the last admin cannot leave", async () => {
    mockApi({
      ...adminReplies,
      "POST /api/groups/g1/leave": { status: 409, body: { detail: "last_admin" } },
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Leave group" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, leave" }));

    expect((await screen.findByRole("alert")).textContent).toContain("at least one admin");
    expect(screen.queryByText("List page")).toBeNull();
  });

  it("removes another member after confirmation, but offers no removal of oneself", async () => {
    const api = mockApi({ ...adminReplies, "DELETE /api/groups/g1/members/u2": { status: 204 } });
    renderDetail();

    const row = (await screen.findByText("Bor")).closest("li")!;
    const self = (await screen.findByText(/\(you\)/)).closest("li")!;
    expect(within(self).queryByRole("button", { name: "Remove" })).toBeNull();

    await userEvent.click(within(row).getByRole("button", { name: "Remove" }));
    expect(within(row).getByText(/Remove Bor from the group/)).toBeTruthy();
    await userEvent.click(within(row).getByRole("button", { name: "Remove from group" }));

    await waitFor(() => expect(bodiesOf(api, "DELETE /api/groups/g1/members/u2")).toHaveLength(1));
  });

  it("warns that removing a guest removes their attendance", async () => {
    const api = mockApi({ ...adminReplies, "DELETE /api/groups/g1/guests/x1": { status: 204 } });
    renderDetail();

    const row = (await screen.findByText("Uncle Bob")).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Remove" }));

    expect(within(row).getByText(/removed as an attendee from all hikes/)).toBeTruthy();
    expect(bodiesOf(api, "DELETE /api/groups/g1/guests/x1")).toHaveLength(0);
    await userEvent.click(within(row).getByRole("button", { name: "Remove guest" }));

    await waitFor(() => expect(bodiesOf(api, "DELETE /api/groups/g1/guests/x1")).toHaveLength(1));
  });

  it("renames a guest", async () => {
    const api = mockApi({
      ...adminReplies,
      "PATCH /api/groups/g1/guests/x1": { id: "x1", nickname: "Robert" },
    });
    renderDetail();

    const row = (await screen.findByText("Uncle Bob")).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("Nickname");
    await userEvent.clear(input);
    await userEvent.type(input, "Robert");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.bodyOf("PATCH /api/groups/g1/guests/x1")).toEqual({ nickname: "Robert" }),
    );
    expect(await screen.findByText("Uncle Bob")).toBeTruthy(); // the mocked list has not changed
  });

  it("invites by e-mail and confirms", async () => {
    const api = mockApi({
      ...adminReplies,
      "POST /api/groups/g1/invitations": {
        status: 201,
        body: { id: "i2", email: "ana@example.com" },
      },
    });
    renderDetail();

    await userEvent.type(await screen.findByLabelText("E-mail address"), "Ana@Example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(await screen.findByText("Invitation sent to ana@example.com.")).toBeTruthy();
    expect(api.bodyOf("POST /api/groups/g1/invitations")).toEqual({ email: "Ana@Example.com" });
  });

  it("says so when the invitation e-mail could not be sent", async () => {
    mockApi({
      ...adminReplies,
      "POST /api/groups/g1/invitations": { status: 503, body: { detail: "email_failed" } },
    });
    renderDetail();

    await userEvent.type(await screen.findByLabelText("E-mail address"), "ana@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));

    expect((await screen.findByRole("alert")).textContent).toContain("could not be sent");
    expect(screen.queryByText(/Invitation sent/)).toBeNull();
  });

  it("lists pending invitations, which can be resent and revoked", async () => {
    const api = mockApi({
      ...adminReplies,
      "POST /api/groups/g1/invitations/i1/resend": { id: "i1" },
      "DELETE /api/groups/g1/invitations/i1": { status: 204 },
    });
    renderDetail();

    const row = (await screen.findByText("new@example.com")).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Send again" }));
    expect(await within(row).findByText(/previous one no longer works/)).toBeTruthy();

    await userEvent.click(within(row).getByRole("button", { name: "Revoke" }));
    await userEvent.click(within(row).getByRole("button", { name: "Revoke invitation" }));

    await waitFor(() =>
      expect(bodiesOf(api, "DELETE /api/groups/g1/invitations/i1")).toHaveLength(1),
    );
  });

  it("marks expired invitations", async () => {
    mockApi({
      ...adminReplies,
      "GET /api/groups/g1/invitations?limit=200": page([
        { id: "i1", email: "old@example.com", expires_at: "2020-01-01T00:00:00Z", expired: true },
      ]),
    });
    renderDetail();

    const row = (await screen.findByText("old@example.com")).closest("li")!;
    expect(within(row).getByText("Expired")).toBeTruthy();
  });

  it("approves and rejects join requests", async () => {
    const api = mockApi({
      ...adminReplies,
      "POST /api/groups/g1/join-requests/r1/approve": { id: "r1" },
      "POST /api/groups/g1/join-requests/r1/reject": { id: "r1" },
    });
    renderDetail();

    const row = (await screen.findByText("Requester")).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(bodiesOf(api, "POST /api/groups/g1/join-requests/r1/approve")).toHaveLength(1),
    );
    await userEvent.click(within(row).getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(bodiesOf(api, "POST /api/groups/g1/join-requests/r1/reject")).toHaveLength(1),
    );
  });

  it("edits the group", async () => {
    const api = mockApi({
      ...adminReplies,
      "PATCH /api/groups/g1": { ...adminGroup, name: "New name" },
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const name = screen.getByLabelText("Name");
    expect((name as HTMLInputElement).value).toBe("Hikers");
    await userEvent.clear(name);
    await userEvent.type(name, "New name");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.bodyOf("PATCH /api/groups/g1")).toEqual({
        name: "New name",
        description: "We walk.",
        visibility: "public",
      }),
    );
    await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
  });

  it("explains the consequences before deleting, without a browser dialog", async () => {
    const api = mockApi({ ...adminReplies, "DELETE /api/groups/g1": { status: 204 } });
    const confirm = vi.fn();
    vi.stubGlobal("confirm", confirm);
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Delete group" }));

    const box = screen.getByRole("group", { name: "Delete group" });
    expect(box.textContent).toContain("personal statistics");
    expect(box.textContent).toContain("guests are removed");
    expect(box.textContent).toContain("become private");
    expect(box.textContent).toContain("cannot be undone");
    expect(bodiesOf(api, "DELETE /api/groups/g1")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Yes, delete the group" }));

    expect(await screen.findByText("List page")).toBeTruthy();
    expect(bodiesOf(api, "DELETE /api/groups/g1")).toHaveLength(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("stays on the page and shows why when deleting fails", async () => {
    mockApi({
      ...adminReplies,
      "DELETE /api/groups/g1": { status: 403, body: { detail: "forbidden" } },
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Delete group" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, delete the group" }));

    expect((await screen.findByRole("alert")).textContent).toBe("You are not allowed to do this.");
    expect(screen.queryByText("List page")).toBeNull();
  });
});

describe("GroupActivity", () => {
  it("renders in Slovenian", async () => {
    await i18n.changeLanguage("sl");
    render(<GroupActivity groupId="g1" />);

    expect(screen.getByRole("link", { name: "Pohodi skupine" })).toBeTruthy();
  });
});
