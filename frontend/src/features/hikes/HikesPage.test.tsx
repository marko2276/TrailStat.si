import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { mockApi } from "../../test/mockApi";
import { render } from "../../test/render";
import { makeHike, page } from "./fixtures";
import { HikesPage } from "./HikesPage";

vi.mock("../../auth/hanko", () => ({
  getHanko: () => new Promise(() => undefined),
  getSessionToken: () => "token",
  isHankoConfigured: true,
}));

const LIST = "GET /api/hikes?limit=20&offset=0";

describe("my hikes", () => {
  it("shows hikes with their formatted details", async () => {
    mockApi({
      [LIST]: page([
        makeHike({
          notes: "Sunny",
          group_id: "g1",
          group_name: "Planinci",
          attendees: [
            { user_id: "me", guest_id: null, name: "Marko" },
            { user_id: null, guest_id: "x", name: "Gost Jure" },
          ],
        }),
      ]),
    });
    render(<HikesPage />);

    expect(await screen.findByRole("heading", { name: "Triglav" })).toBeTruthy();
    expect(screen.getByText(/12\.5 km/)).toBeTruthy();
    expect(screen.getByText(/1h|1 hr|1 hour/)).toBeTruthy();
    expect(screen.getByText("Planinci")).toBeTruthy();
    expect(screen.getByText("Attended by: Marko, Gost Jure")).toBeTruthy();
    expect(screen.getByText("Sunny")).toBeTruthy();
    expect(screen.getByText("1 hike")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Record a hike" }).getAttribute("href")).toBe(
      "/hikes/new",
    );
  });

  it("shows an empty state", async () => {
    mockApi({ [LIST]: page([]) });
    render(<HikesPage />);
    expect(await screen.findByText("You have no recorded hikes yet.")).toBeTruthy();
  });

  it("shows an error when the list fails", async () => {
    mockApi({ [LIST]: { status: 500, body: { detail: "internal" } } });
    render(<HikesPage />);
    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong");
  });

  it("marks an archived trail", async () => {
    const hike = makeHike();
    mockApi({ [LIST]: page([{ ...hike, trail: { ...hike.trail, archived: true } }]) });
    render(<HikesPage />);
    expect(await screen.findByText("Archived trail")).toBeTruthy();
  });

  it("pages through the list", async () => {
    const api = mockApi({
      [LIST]: page([makeHike({ id: "first" })], 45),
      "GET /api/hikes?limit=20&offset=20": page(
        [makeHike({ id: "second", trail: { ...makeHike().trail, name: "Vogel" } })],
        45,
      ),
    });
    render(<HikesPage />);

    expect(await screen.findByText("Page 1 of 3")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Previous" }).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByRole("heading", { name: "Vogel" })).toBeTruthy();
    expect(screen.getByText("Page 2 of 3")).toBeTruthy();
    expect(api.requests.map((request) => request.key)).toContain(
      "GET /api/hikes?limit=20&offset=20",
    );
  });

  it("says the count with Slovenian's plural forms", async () => {
    await i18n.changeLanguage("sl");
    const t = i18n.getFixedT("sl", "hikes");
    expect(t("count", { count: 1 })).toBe("1 pohod");
    expect(t("count", { count: 2 })).toBe("2 pohoda");
    expect(t("count", { count: 3 })).toBe("3 pohodi");
    expect(t("count", { count: 4 })).toBe("4 pohodi");
    expect(t("count", { count: 5 })).toBe("5 pohodov");
    expect(t("count", { count: 101 })).toBe("101 pohod");
    expect(t("count", { count: 102 })).toBe("102 pohoda");
    expect(t("count", { count: 203 })).toBe("203 pohodi");
    expect(t("count", { count: 0 })).toBe("0 pohodov");

    mockApi({ [LIST]: page([makeHike()], 2) });
    render(<HikesPage />);
    expect(await screen.findByText("2 pohoda")).toBeTruthy();
  });
});

describe("controls follow the permissions", () => {
  it.each([
    { can_edit: true, can_delete: true, edit: true, remove: true },
    { can_edit: true, can_delete: false, edit: true, remove: false },
    { can_edit: false, can_delete: false, edit: false, remove: false },
  ])(
    "can_edit $can_edit, can_delete $can_delete",
    async ({ can_edit, can_delete, edit, remove }) => {
      mockApi({
        [LIST]: page([makeHike({ group_id: "g1", group_name: "Planinci", can_edit, can_delete })]),
      });
      render(<HikesPage />);

      await screen.findByRole("heading", { name: "Triglav" });
      expect(screen.queryByRole("link", { name: "Edit" }) !== null).toBe(edit);
      expect(screen.queryByRole("button", { name: "Delete" }) !== null).toBe(remove);
    },
  );

  it("links to the edit page", async () => {
    mockApi({ [LIST]: page([makeHike()]) });
    render(<HikesPage />);
    const link = await screen.findByRole("link", { name: "Edit" });
    expect(link.getAttribute("href")).toBe("/hikes/h1/edit");
  });
});

describe("deleting", () => {
  it("asks on the page first, and cancelling sends nothing", async () => {
    const confirm = vi.fn();
    vi.stubGlobal("confirm", confirm);
    const api = mockApi({ [LIST]: page([makeHike()]) });
    render(<HikesPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));

    const dialog = screen.getByRole("group", { name: "Confirm removal" });
    expect(dialog.textContent).toContain("Delete this hike permanently?");
    expect(confirm).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("group", { name: "Confirm removal" })).toBeNull();
    expect(api.requests.filter((request) => request.key.startsWith("DELETE"))).toEqual([]);
  });

  it("deletes after confirming and refreshes the list", async () => {
    const api = mockApi({ [LIST]: page([makeHike()]), "DELETE /api/hikes/h1": { status: 204 } });
    render(<HikesPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(api.requests.map((request) => request.key)).toContain("DELETE /api/hikes/h1"),
    );
    await waitFor(() =>
      expect(api.requests.filter((request) => request.key === LIST)).toHaveLength(2),
    );
  });

  it("shows an error when deleting fails", async () => {
    mockApi({
      [LIST]: page([makeHike()]),
      "DELETE /api/hikes/h1": { status: 403, body: { detail: "forbidden" } },
    });
    render(<HikesPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect((await screen.findByRole("alert")).textContent).toContain("You are not allowed");
  });

  it("shows a hike from a group the user has left, with only their own part", async () => {
    mockApi({
      [LIST]: page([
        makeHike({
          recorded_by: null,
          group_id: null,
          group_name: null,
          notes: null,
          can_edit: false,
          can_delete: false,
        }),
      ]),
    });
    render(<HikesPage />);

    const card = (await screen.findByRole("heading", { name: "Triglav" })).closest("article")!;
    expect(card.textContent).not.toContain("Attended by");
    expect(card.querySelector(".badge")).toBeNull();
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove from my history" })).toBeNull();
  });

  it("says it only affects your history when the group is gone and others attended", async () => {
    mockApi({
      [LIST]: page([
        makeHike({
          recorded_by: "someone",
          can_edit: false,
          can_delete: true,
          attendees: [
            { user_id: "me", guest_id: null, name: "Marko" },
            { user_id: "other", guest_id: null, name: "Ana" },
          ],
        }),
      ]),
    });
    render(<HikesPage />);

    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Remove from my history" }));

    expect(screen.getByRole("group", { name: "Confirm removal" }).textContent).toContain(
      "removes the hike from your history only",
    );
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
  });
});

describe("a group's hikes", () => {
  const group = { id: "g1", name: "Planinci", is_member: true };
  const groupList = "GET /api/groups/g1/hikes?limit=20&offset=0";

  it("uses the group's list when the URL names a group", async () => {
    mockApi({
      "GET /api/groups/g1": group,
      [groupList]: page([makeHike({ group_id: "g1", group_name: "Planinci" })]),
    });
    render(<HikesPage />, { route: "/hikes?group=g1" });

    expect(await screen.findByRole("heading", { name: "Hikes of Planinci" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Triglav" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Record a hike" }).getAttribute("href")).toBe(
      "/hikes/new?group=g1",
    );
  });

  it("shows an error to a non-member, without a way to record", async () => {
    mockApi({
      "GET /api/groups/g1": { ...group, is_member: false },
      [groupList]: { status: 403, body: { detail: "forbidden" } },
    });
    render(<HikesPage />, { route: "/hikes?group=g1" });

    expect((await screen.findByRole("alert")).textContent).toContain("You are not allowed");
    expect(screen.queryByRole("link", { name: "Record a hike" })).toBeNull();
  });

  it("hides a group the user may not see", async () => {
    mockApi({
      "GET /api/groups/g1": { status: 404, body: { detail: "not_found" } },
      [groupList]: { status: 404, body: { detail: "not_found" } },
    });
    render(<HikesPage />, { route: "/hikes?group=g1" });
    expect((await screen.findByRole("alert")).textContent).toContain("does not exist");
  });
});
