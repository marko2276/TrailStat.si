import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router";
import { mockApi } from "../../test/mockApi";
import { render } from "../../test/render";
import { makeHike, makeTrail, me, page } from "./fixtures";
import { EditHikePage, RecordHikePage } from "./RecordHikePage";

vi.mock("../../auth/hanko", () => ({
  getHanko: () => new Promise(() => undefined),
  getSessionToken: () => "token",
  isHankoConfigured: true,
}));

const originalZone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Europe/Ljubljana";
});
afterAll(() => {
  process.env.TZ = originalZone;
});

const TRAILS = "GET /api/trails?include_archived=false&limit=200";
const GROUPS = "GET /api/groups?scope=mine&limit=200";
const group = { id: "g1", name: "Planinci", is_member: true };
const base = {
  "GET /api/me": me,
  [GROUPS]: page([group]),
  [TRAILS]: page([makeTrail()]),
};
const groupReplies = {
  "GET /api/groups/g1/members": {
    items: [
      { user_id: "me", display_name: "Marko", role: "admin" },
      { user_id: "ana", display_name: "Ana", role: "member" },
    ],
  },
  "GET /api/groups/g1/guests": { items: [{ id: "jure", nickname: "Jure" }] },
};

function renderRecord(route = "/hikes/new") {
  return render(
    <Routes>
      <Route path="/hikes/new" element={<RecordHikePage />} />
      <Route path="/hikes" element={<p>The list</p>} />
    </Routes>,
    { route },
  );
}

function renderEdit() {
  return render(
    <Routes>
      <Route path="/hikes/:id/edit" element={<EditHikePage />} />
      <Route path="/hikes" element={<p>The list</p>} />
    </Routes>,
    { route: "/hikes/h1/edit" },
  );
}

function setValue(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function fillTimes(date = "2024-07-01", time = "09:30", hours = "2", minutes = "15") {
  setValue("Date", date);
  setValue("Start time", time);
  setValue("Hours", hours);
  setValue("Minutes", minutes);
  return Promise.resolve();
}

async function chooseTrail(name = "Triglav") {
  await userEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
}

function save() {
  return userEvent.click(screen.getByRole("button", { name: "Save" }));
}

describe("recording a personal hike", () => {
  it("sends the local time as an instant with its offset, and the duration in seconds", async () => {
    const api = mockApi({ ...base, "POST /api/hikes": { status: 201, body: makeHike() } });
    renderRecord();

    await chooseTrail();
    await fillTimes("2024-07-01", "09:30", "2", "15");
    setValue("Notes (optional)", "  Sunny  ");
    await save();

    await screen.findByText("The list");
    expect(api.bodyOf("POST /api/hikes")).toEqual({
      trail_id: "t1",
      start_at: "2024-07-01T09:30:00+02:00",
      duration_s: 2 * 3600 + 15 * 60,
      notes: "Sunny",
      group_id: null,
      attendee_user_ids: [],
      attendee_guest_ids: [],
    });
  });

  it("uses the winter offset for a winter date", async () => {
    const api = mockApi({ ...base, "POST /api/hikes": { status: 201, body: makeHike() } });
    renderRecord();

    await chooseTrail();
    await fillTimes("2024-01-15", "09:30", "1", "0");
    await save();

    await screen.findByText("The list");
    expect(api.bodyOf("POST /api/hikes")).toMatchObject({
      start_at: "2024-01-15T09:30:00+01:00",
      duration_s: 3600,
      notes: null,
    });
  });

  it("searches trails, without archived ones", async () => {
    const api = mockApi({
      ...base,
      "GET /api/trails?q=vog&include_archived=false&limit=200": page([
        makeTrail({ id: "t2", name: "Vogel" }),
        makeTrail({ id: "t3", name: "Vogar", archived: true }),
      ]),
    });
    renderRecord();

    await screen.findByRole("button", { name: /Triglav/ });
    await userEvent.type(screen.getByLabelText("Search trails"), "vog");

    expect(await screen.findByRole("button", { name: /Vogel/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Vogar/ })).toBeNull();
    expect(api.requests.map((request) => request.key)).toContain(
      "GET /api/trails?q=vog&include_archived=false&limit=200",
    );
  });

  it("says when no trail matches", async () => {
    mockApi({ ...base, [TRAILS]: page([]) });
    renderRecord();
    expect(await screen.findByText("No trails found.")).toBeTruthy();
  });

  it("shows an error when searching fails", async () => {
    mockApi({ ...base, [TRAILS]: { status: 500 } });
    renderRecord();
    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong");
  });

  it.each([
    ["no trail", false, "2024-07-01", "09:30", "1", "0", "Choose a trail."],
    ["no time", true, "2024-07-01", "", "1", "0", "Enter the date and start time."],
    ["no date", true, "", "09:30", "1", "0", "Enter the date and start time."],
    ["no duration", true, "2024-07-01", "09:30", "", "", "Enter how long the hike took."],
    ["a zero duration", true, "2024-07-01", "09:30", "0", "0", "Enter how long the hike took."],
    ["a negative duration", true, "2024-07-01", "09:30", "1", "-5", "Enter how long"],
    ["too long a duration", true, "2024-07-01", "09:30", "721", "0", "at most 30 days"],
    ["a future date", true, "2999-01-01", "09:30", "1", "0", "can't be in the future"],
  ])("doesn't send %s", async (_name, pickTrail, date, time, hours, minutes, message) => {
    const api = mockApi(base);
    renderRecord();

    if (pickTrail) await chooseTrail();
    else await screen.findByRole("button", { name: /Triglav/ });
    await fillTimes(date, time, hours, minutes);
    await save();

    expect(screen.getByRole("alert").textContent).toContain(message);
    expect(api.requests.filter((request) => request.key.startsWith("POST"))).toEqual([]);
  });

  it.each([
    ["trail_archived", "This trail is archived"],
    ["start_at_in_future", "can't be in the future"],
    ["not_found", "does not exist"],
  ])("translates the server's %s", async (detail, message) => {
    mockApi({ ...base, "POST /api/hikes": { status: 422, body: { detail } } });
    renderRecord();

    await chooseTrail();
    await fillTimes();
    await save();

    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(screen.queryByText("The list")).toBeNull();
  });

  it("cancelling goes back to the list without saving", async () => {
    const api = mockApi(base);
    renderRecord();
    await screen.findByLabelText("Date");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByText("The list");
    expect(api.requests.filter((request) => request.key.startsWith("POST"))).toEqual([]);
  });
});

describe("recording a group hike", () => {
  async function chooseGroup() {
    await screen.findByRole("option", { name: "Planinci" });
    await userEvent.selectOptions(screen.getByLabelText("Type of hike"), "g1");
    await screen.findByRole("checkbox", { name: "Ana" });
  }

  it("sends the chosen members and guests, with the recorder pre-selected", async () => {
    const api = mockApi({
      ...base,
      ...groupReplies,
      "POST /api/hikes": {
        status: 201,
        body: makeHike({ group_id: "g1", group_name: "Planinci" }),
      },
      "GET /api/groups/g1/hikes?limit=20&offset=0": page([]),
    });
    renderRecord();

    await chooseGroup();
    await chooseTrail();
    await fillTimes();
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Marko" }).checked).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: "Ana" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Jure/ }));
    await save();

    await waitFor(() =>
      expect(api.bodyOf("POST /api/hikes")).toMatchObject({
        group_id: "g1",
        attendee_user_ids: ["me", "ana"],
        attendee_guest_ids: ["jure"],
      }),
    );
  });

  it("the recorder can leave themselves out", async () => {
    const api = mockApi({
      ...base,
      ...groupReplies,
      "POST /api/hikes": { status: 201, body: makeHike({ group_id: "g1" }) },
    });
    renderRecord();

    await chooseGroup();
    await chooseTrail();
    await fillTimes();
    await userEvent.click(screen.getByRole("checkbox", { name: "Marko" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Ana" }));
    await save();

    await waitFor(() =>
      expect(api.bodyOf("POST /api/hikes")).toMatchObject({
        attendee_user_ids: ["ana"],
        attendee_guest_ids: [],
      }),
    );
  });

  it("needs at least one attendee", async () => {
    const api = mockApi({ ...base, ...groupReplies });
    renderRecord();

    await chooseGroup();
    await chooseTrail();
    await fillTimes();
    await userEvent.click(screen.getByRole("checkbox", { name: "Marko" }));
    await save();

    expect(screen.getByRole("alert").textContent).toContain("Select at least one attendee.");
    expect(api.requests.filter((request) => request.key.startsWith("POST"))).toEqual([]);
  });

  it("adds a new guest inline and selects them, with Enter not submitting the hike", async () => {
    const guests = "POST /api/groups/g1/guests";
    const api = mockApi({
      ...base,
      ...groupReplies,
      [guests]: { status: 201, body: { id: "new", nickname: "Nova" } },
      "POST /api/hikes": { status: 201, body: makeHike({ group_id: "g1" }) },
    });
    renderRecord();

    await chooseGroup();
    await chooseTrail();
    await fillTimes();
    await userEvent.type(screen.getByLabelText("New guest's nickname"), "  Nova  {Enter}");

    await waitFor(() => expect(api.bodyOf(guests)).toEqual({ nickname: "Nova" }));
    expect(api.requests.filter((request) => request.key === "POST /api/hikes")).toEqual([]);
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>("New guest's nickname").value).toBe(""),
    );

    await save();
    await waitFor(() =>
      expect(api.bodyOf("POST /api/hikes")).toMatchObject({ attendee_guest_ids: ["new"] }),
    );
  });

  it("selects the existing guest when the nickname is already known", async () => {
    const api = mockApi({ ...base, ...groupReplies });
    renderRecord();

    await chooseGroup();
    await userEvent.type(screen.getByLabelText("New guest's nickname"), "jure");
    await userEvent.click(screen.getByRole("button", { name: "Add guest" }));

    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /Jure/ }).checked).toBe(true);
    expect(
      api.requests.filter(
        (request) => request.key.includes("guests") && request.key.startsWith("POST"),
      ),
    ).toEqual([]);
  });

  it("shows an error when adding a guest fails", async () => {
    mockApi({
      ...base,
      ...groupReplies,
      "POST /api/groups/g1/guests": { status: 500 },
    });
    renderRecord();

    await chooseGroup();
    await userEvent.type(screen.getByLabelText("New guest's nickname"), "Nova");
    await userEvent.click(screen.getByRole("button", { name: "Add guest" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong");
  });

  it("offers only trails the whole group can see", async () => {
    mockApi({
      ...base,
      ...groupReplies,
      [TRAILS]: page([
        makeTrail({ id: "pub", name: "Public one" }),
        makeTrail({ id: "shared", name: "Shared one", visibility: "group", group_id: "g1" }),
        makeTrail({ id: "other", name: "Other group", visibility: "group", group_id: "g2" }),
        makeTrail({ id: "mine", name: "My private", visibility: "private" }),
      ]),
    });
    renderRecord();

    expect(await screen.findByRole("button", { name: /My private/ })).toBeTruthy();
    await chooseGroup();

    expect(screen.getByRole("button", { name: /Public one/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Shared one/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Other group/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /My private/ })).toBeNull();
  });

  it("drops a private trail already chosen when switching to a group", async () => {
    mockApi({
      ...base,
      ...groupReplies,
      [TRAILS]: page([makeTrail({ id: "mine", name: "My private", visibility: "private" })]),
    });
    renderRecord();

    await chooseTrail("My private");
    expect(screen.getByRole("button", { name: "Change trail" })).toBeTruthy();
    await chooseGroup();

    expect(screen.queryByRole("button", { name: "Change trail" })).toBeNull();
    expect(await screen.findByText("No trails found.")).toBeTruthy();
  });

  it("explains the server's trail_not_visible_to_group", async () => {
    mockApi({
      ...base,
      ...groupReplies,
      "POST /api/hikes": { status: 422, body: { detail: "trail_not_visible_to_group" } },
    });
    renderRecord();

    await chooseGroup();
    await chooseTrail();
    await fillTimes();
    await save();

    expect((await screen.findByRole("alert")).textContent).toContain("can't see this trail");
  });

  it("opens with the group from the URL selected", async () => {
    mockApi({ ...base, ...groupReplies });
    renderRecord("/hikes/new?group=g1");

    await screen.findByRole("checkbox", { name: "Ana" });
    expect(screen.getByLabelText<HTMLSelectElement>("Type of hike").value).toBe("g1");
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Marko" }).checked).toBe(true);
  });
});

describe("editing", () => {
  const url = "/api/hikes/h1";

  it("shows the current values in local time and sends only what changed", async () => {
    const hike = makeHike({ start_at: "2024-07-01T07:30:15Z", duration_s: 5425, notes: "Old" });
    const api = mockApi({ ...base, [`GET ${url}`]: hike, [`PATCH ${url}`]: hike });
    renderEdit();

    const date = await screen.findByLabelText<HTMLInputElement>("Date");
    expect(date.value).toBe("2024-07-01");
    expect(screen.getByLabelText<HTMLInputElement>("Start time").value).toBe("09:30");
    expect(screen.getByLabelText<HTMLInputElement>("Hours").value).toBe("1");
    expect(screen.getByLabelText<HTMLInputElement>("Minutes").value).toBe("30");

    setValue("Notes (optional)", "New");
    await save();

    await screen.findByText("The list");
    // Not start_at or duration_s: resending them would lose their seconds.
    expect(api.bodyOf(`PATCH ${url}`)).toEqual({ notes: "New" });
  });

  it("sends a changed start and duration", async () => {
    const hike = makeHike();
    const api = mockApi({ ...base, [`GET ${url}`]: hike, [`PATCH ${url}`]: hike });
    renderEdit();

    await screen.findByLabelText("Date");
    await fillTimes("2024-01-15", "08:00", "3", "0");
    await save();

    await screen.findByText("The list");
    expect(api.bodyOf(`PATCH ${url}`)).toEqual({
      start_at: "2024-01-15T08:00:00+01:00",
      duration_s: 3 * 3600,
    });
  });

  it("keeps an archived trail until another is chosen", async () => {
    const original = makeHike();
    const hike = { ...original, trail: { ...original.trail, archived: true } };
    const api = mockApi({
      ...base,
      [`GET ${url}`]: hike,
      [`PATCH ${url}`]: hike,
      [TRAILS]: page([makeTrail({ id: "t2", name: "Vogel" })]),
    });
    renderEdit();

    expect(await screen.findByText("Archived trail")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Change trail" }));
    await chooseTrail("Vogel");
    await save();

    await screen.findByText("The list");
    expect(api.bodyOf(`PATCH ${url}`)).toEqual({ trail_id: "t2" });
  });

  it("keeps a former member's attendance, and can change the attendees", async () => {
    const hike = makeHike({
      group_id: "g1",
      group_name: "Planinci",
      attendees: [
        { user_id: "ana", guest_id: null, name: "Ana" },
        { user_id: "left", guest_id: null, name: "Bor" },
      ],
    });
    const api = mockApi({
      ...base,
      ...groupReplies,
      [`GET ${url}`]: hike,
      [`PATCH ${url}`]: hike,
      "GET /api/groups/g1/hikes?limit=20&offset=0": page([]),
    });
    renderEdit();

    const former = await screen.findByRole<HTMLInputElement>("checkbox", { name: /Bor/ });
    expect(former.checked).toBe(true);
    expect(former.closest("label")?.textContent).toContain("former member");
    expect(screen.getByText("Group hike: Planinci")).toBeTruthy();
    // A hike can't move to another group.
    expect(screen.queryByLabelText("Type of hike")).toBeNull();

    await userEvent.click(screen.getByRole("checkbox", { name: "Marko" }));
    await save();

    await waitFor(() =>
      expect(api.bodyOf(`PATCH ${url}`)).toEqual({ attendee_user_ids: ["ana", "left", "me"] }),
    );
  });

  it("doesn't offer attendees on a personal hike", async () => {
    mockApi({ ...base, [`GET ${url}`]: makeHike() });
    renderEdit();

    await screen.findByLabelText("Date");
    expect(screen.getByText("Personal hike")).toBeTruthy();
    expect(screen.queryByText("Who attended?")).toBeNull();
  });

  it("shows no form to someone who may not edit", async () => {
    mockApi({ ...base, [`GET ${url}`]: makeHike({ can_edit: false }) });
    renderEdit();

    expect((await screen.findByRole("alert")).textContent).toContain("You are not allowed");
    expect(screen.queryByLabelText("Date")).toBeNull();
  });

  it("reports a hike that can't be seen", async () => {
    mockApi({ ...base, [`GET ${url}`]: { status: 404, body: { detail: "not_found" } } });
    renderEdit();
    expect((await screen.findByRole("alert")).textContent).toContain("does not exist");
  });

  it("shows the server's error and stays on the form", async () => {
    mockApi({
      ...base,
      [`GET ${url}`]: makeHike(),
      [`PATCH ${url}`]: { status: 403, body: { detail: "forbidden" } },
    });
    renderEdit();

    await screen.findByLabelText("Date");
    setValue("Notes (optional)", "New");
    await save();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("You are not allowed");
    expect(within(document.body).queryByText("The list")).toBeNull();
  });
});

describe("choosing a trail for a group hike", () => {
  it("finds the group's trail behind many that the group can't use", async () => {
    const own = Array.from({ length: 25 }, (_, index) =>
      makeTrail({ id: `own${index}`, name: `Aaa ${index}`, visibility: "private" }),
    );
    const shared = makeTrail({
      id: "shared",
      name: "Zadnja pot",
      visibility: "group",
      group_id: "g1",
    });
    mockApi({ ...base, ...groupReplies, [TRAILS]: page([...own, shared]) });
    renderRecord("/hikes/new?group=g1");

    expect(await screen.findByRole("button", { name: /Zadnja pot/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Aaa 0/ })).toBeNull();
  });
});
