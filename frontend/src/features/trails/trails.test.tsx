import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { mockApi } from "../../test/mockApi";
import { render } from "../../test/render";
import { ElevationChart, niceTicks } from "./ElevationChart";
import { OsmImportPage } from "./OsmImportPage";
import { TrailDetailPage } from "./TrailDetailPage";
import { EditTrailPage, NewTrailPage } from "./TrailFormPages";
import { TrailsPage } from "./TrailsPage";

vi.mock("../../auth/hanko", () => ({
  getHanko: () => new Promise(() => undefined),
  getSessionToken: () => "token",
  isHankoConfigured: true,
}));

// jsdom has no WebGL. Stands in for the real map, and shows what it was given.
vi.mock("./TrailMap", () => ({
  default: ({
    geometry,
    label,
    onVisibleAreaChange,
  }: {
    geometry?: { coordinates: unknown[] } | null;
    label: string;
    onVisibleAreaChange?: (bbox: string) => void;
  }) => (
    <div role="region" aria-label={label} data-points={geometry?.coordinates.length ?? 0}>
      {onVisibleAreaChange && (
        <button onClick={() => onVisibleAreaChange("13.5,45.5,14.5,46.5")}>report map area</button>
      )}
    </div>
  ),
}));

const summary = {
  id: "t1",
  name: "Šmarna gora",
  visibility: "public",
  group_id: null,
  owner_user_id: "u1",
  can_edit: false,
  source: "manual",
  distance_m: 4200,
  elevation_gain_m: 350,
  archived: false,
};

const manualDetail = {
  ...summary,
  owner_name: "Marko",
  group_name: null,
  description: "Lepa pot",
  elevation_loss_m: null,
  highest_point_m: 669,
  geometry: null,
  elevation_profile: null,
  osm_relation_id: null,
  created_at: "2026-11-01T10:00:00Z",
  updated_at: "2026-11-01T10:00:00Z",
};

const line = {
  type: "LineString",
  coordinates: [
    [13.8, 46.4],
    [13.81, 46.41],
    [13.82, 46.42],
  ],
};

const osmDetail = {
  ...manualDetail,
  source: "osm",
  osm_relation_id: 19446684,
  geometry: line,
  elevation_gain_m: 300,
  elevation_loss_m: 40,
  highest_point_m: 1300,
  elevation_profile: [
    [0, 1000],
    [1000, 1300],
    [2000, 1260],
  ],
};

function page<T>(items: T[], total = items.length) {
  return { items, total, limit: 25, offset: 0 };
}

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function renderRoutes(route: string) {
  return render(
    <>
      <Routes>
        <Route path="/trails" element={<TrailsPage />} />
        <Route path="/trails/new" element={<NewTrailPage />} />
        <Route path="/trails/import" element={<OsmImportPage />} />
        <Route path="/trails/:id" element={<TrailDetailPage />} />
        <Route path="/trails/:id/edit" element={<EditTrailPage />} />
      </Routes>
      <Location />
    </>,
    { route },
  );
}

function currentLocation() {
  return screen.getByTestId("location").textContent;
}

describe("trail list", () => {
  it("shows trails with their distance, gain and visibility, linking to the detail page", async () => {
    mockApi({ "GET /api/trails?limit=25": page([summary]) });
    renderRoutes("/trails");

    const link = await screen.findByRole("link", { name: "Šmarna gora" });

    expect(link.getAttribute("href")).toBe("/trails/t1");
    const row = within(link.closest("li")!);
    expect(row.getByText("4.2 km")).toBeTruthy();
    expect(row.getByText("350 m gain")).toBeTruthy();
    expect(row.getByText("Public")).toBeTruthy();
  });

  it("says when a trail has no elevation data, and marks archived trails", async () => {
    mockApi({
      "GET /api/trails?limit=25": page([{ ...summary, elevation_gain_m: null, archived: true }]),
    });
    renderRoutes("/trails");

    expect(await screen.findByText("No elevation data")).toBeTruthy();
    expect(screen.getByText("Archived")).toBeTruthy();
  });

  it("asks for trails to be added when there are none", async () => {
    mockApi({ "GET /api/trails?limit=25": page([]) });
    renderRoutes("/trails");

    expect(await screen.findByText(/There are no trails yet/)).toBeTruthy();
  });

  it("shows an error when the list cannot be loaded", async () => {
    mockApi({ "GET /api/trails?limit=25": { status: 500, body: { detail: "internal" } } });
    renderRoutes("/trails");

    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong");
  });

  it("searches by name after typing stops, and says when nothing matches", async () => {
    const api = mockApi({
      "GET /api/trails?limit=25": page([summary]),
      "GET /api/trails?q=krim&limit=25": page([]),
    });
    renderRoutes("/trails");
    await screen.findByText("Šmarna gora");

    await userEvent.type(screen.getByLabelText("Search by name"), "krim");

    expect(await screen.findByText("No trails match your search.")).toBeTruthy();
    expect(currentLocation()).toBe("/trails?q=krim");
    // Not one request per letter
    expect(api.requests.map((request) => request.key)).toEqual([
      "GET /api/trails?limit=25",
      "GET /api/trails?q=krim&limit=25",
    ]);
  });

  it("filters, sorts and shows archived trails on request", async () => {
    const api = mockApi({
      "GET /api/trails?limit=25": page([summary]),
      "GET /api/trails?scope=mine&limit=25": page([summary]),
      "GET /api/trails?scope=mine&sort=elevation&limit=25": page([summary]),
      "GET /api/trails?scope=mine&sort=elevation&order=desc&limit=25": page([summary]),
      "GET /api/trails?scope=mine&include_archived=true&sort=elevation&order=desc&limit=25": page([
        { ...summary, name: "Stara pot", archived: true },
      ]),
    });
    renderRoutes("/trails");
    await screen.findByText("Šmarna gora");

    await userEvent.selectOptions(screen.getByLabelText("Show"), "Mine");
    await userEvent.selectOptions(screen.getByLabelText("Sort by"), "Elevation gain");
    await userEvent.selectOptions(screen.getByLabelText("Order"), "Descending");
    await userEvent.click(screen.getByLabelText("Show archived"));

    expect(await screen.findByText("Stara pot")).toBeTruthy();
    expect(api.requests.at(-1)?.key).toContain("include_archived=true");
  });

  it("offers all four filters", async () => {
    mockApi({ "GET /api/trails?limit=25": page([]) });
    renderRoutes("/trails");
    await screen.findByText(/There are no trails yet/);

    const options = within(screen.getByLabelText("Show")).getAllByRole("option");

    expect(options.map((option) => option.textContent)).toEqual(["All", "Public", "Mine", "Group"]);
  });

  it("keeps the filters from the URL", async () => {
    mockApi({ "GET /api/trails?scope=group&sort=distance&limit=25": page([summary]) });
    renderRoutes("/trails?scope=group&sort=distance");

    await screen.findByText("Šmarna gora");

    expect(screen.getByLabelText<HTMLSelectElement>("Show").value).toBe("group");
    expect(screen.getByLabelText<HTMLSelectElement>("Sort by").value).toBe("distance");
  });

  it("pages through long lists and goes back to the first page when a filter changes", async () => {
    mockApi({
      "GET /api/trails?limit=25": page([summary], 30),
      "GET /api/trails?limit=25&offset=25": {
        items: [{ ...summary, name: "Zadnja" }],
        total: 30,
        limit: 25,
        offset: 25,
      },
      "GET /api/trails?scope=public&limit=25": page([{ ...summary, name: "Javna" }]),
    });
    renderRoutes("/trails");
    await screen.findByText("Šmarna gora");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Previous" }).disabled).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByText("Zadnja")).toBeTruthy();
    expect(screen.getByText("26–26 of 30")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Next" }).disabled).toBe(true);

    await userEvent.selectOptions(screen.getByLabelText("Show"), "Public");

    expect(await screen.findByText("Javna")).toBeTruthy();
    expect(currentLocation()).toBe("/trails?scope=public");
  });
});

describe("trail detail", () => {
  it("shows name, numbers, visibility and creator", async () => {
    mockApi({ "GET /api/trails/t1": osmDetail });
    renderRoutes("/trails/t1");

    expect(await screen.findByRole("heading", { name: "Šmarna gora" })).toBeTruthy();
    expect(screen.getByText("Public")).toBeTruthy();
    expect(screen.getByText("Marko")).toBeTruthy();
    expect(screen.getByText("4.2 km")).toBeTruthy();
    expect(screen.getByText("300 m")).toBeTruthy();
    expect(screen.getByText("40 m")).toBeTruthy();
    expect(screen.getByText("1,300 m")).toBeTruthy();
    expect(screen.getByText("Lepa pot")).toBeTruthy();
  });

  it("draws a trail with geometry on a map, with its elevation profile and attributions", async () => {
    mockApi({ "GET /api/trails/t1": osmDetail });
    renderRoutes("/trails/t1");

    const map = await screen.findByRole("region", { name: "Map of the trail Šmarna gora" });

    expect(map.getAttribute("data-points")).toBe("3");
    expect(screen.getByRole("img", { name: "Elevation profile" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /OpenStreetMap contributors/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "View on OpenStreetMap" }).getAttribute("href")).toBe(
      "https://www.openstreetmap.org/relation/19446684",
    );
    expect(screen.getByText(/Copernicus/)).toBeTruthy();
    expect(screen.queryByText(/No elevation data/)).toBeNull();
  });

  it("shows a manual trail without map, profile or OSM credit", async () => {
    mockApi({ "GET /api/trails/t1": manualDetail });
    renderRoutes("/trails/t1");

    expect(await screen.findByText(/entered manually/)).toBeTruthy();
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText(/OpenStreetMap contributors/)).toBeNull();
    expect(screen.queryByText(/No elevation data/)).toBeNull();
  });

  it("explains missing elevation data on an imported trail, and still shows its map", async () => {
    mockApi({
      "GET /api/trails/t1": {
        ...osmDetail,
        elevation_gain_m: null,
        elevation_loss_m: null,
        highest_point_m: null,
        elevation_profile: null,
      },
    });
    renderRoutes("/trails/t1");

    expect((await screen.findByRole("note")).textContent).toContain("No elevation data");
    expect(await screen.findByRole("region")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getAllByText("Not known")).toHaveLength(3);
    expect(screen.queryByText(/Copernicus/)).toBeNull();
  });

  it("hides edit and archive from users who cannot edit", async () => {
    mockApi({ "GET /api/trails/t1": { ...manualDetail, can_edit: false } });
    renderRoutes("/trails/t1");

    await screen.findByRole("heading", { name: "Šmarna gora" });

    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore from archive" })).toBeNull();
  });

  it("hides unarchive on an archived trail from users who cannot edit", async () => {
    mockApi({ "GET /api/trails/t1": { ...manualDetail, can_edit: false, archived: true } });
    renderRoutes("/trails/t1");

    expect(await screen.findByText(/This trail is archived/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore from archive" })).toBeNull();
  });

  it("offers editing to users who can edit, and never offers deleting", async () => {
    mockApi({ "GET /api/trails/t1": { ...manualDetail, can_edit: true } });
    renderRoutes("/trails/t1");

    const edit = await screen.findByRole("link", { name: "Edit" });

    expect(edit.getAttribute("href")).toBe("/trails/t1/edit");
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("archives and unarchives", async () => {
    const editable = { ...manualDetail, can_edit: true };
    const api = mockApi({
      "GET /api/trails/t1": editable,
      "POST /api/trails/t1/archive": { ...editable, archived: true },
      "POST /api/trails/t1/unarchive": { ...editable, archived: false },
    });
    renderRoutes("/trails/t1");

    await userEvent.click(await screen.findByRole("button", { name: "Archive" }));
    const restore = await screen.findByRole("button", { name: "Restore from archive" });
    expect(screen.getByText(/This trail is archived/)).toBeTruthy();

    await userEvent.click(restore);

    expect(await screen.findByRole("button", { name: "Archive" })).toBeTruthy();
    expect(screen.queryByText(/This trail is archived/)).toBeNull();
    expect(api.requests.map((request) => request.key)).toContain("POST /api/trails/t1/unarchive");
  });

  it("shows why archiving failed", async () => {
    mockApi({
      "GET /api/trails/t1": { ...manualDetail, can_edit: true },
      "POST /api/trails/t1/archive": { status: 403, body: { detail: "forbidden" } },
    });
    renderRoutes("/trails/t1");

    await userEvent.click(await screen.findByRole("button", { name: "Archive" }));

    expect((await screen.findByRole("alert")).textContent).toBe("You are not allowed to do this.");
  });

  it("says when a trail does not exist or is hidden", async () => {
    mockApi({ "GET /api/trails/t1": { status: 404, body: { detail: "not_found" } } });
    renderRoutes("/trails/t1");

    expect((await screen.findByRole("alert")).textContent).toContain("does not exist");
  });
});

async function fillManualForm(km = "4,2", gain = "350") {
  await userEvent.type(await screen.findByLabelText("Name"), "  Krim  ");
  await userEvent.type(screen.getByLabelText("Distance (km)"), km);
  await userEvent.type(screen.getByLabelText("Elevation gain (m)"), gain);
}

describe("creating a trail", () => {
  it("sends metres, with a decimal comma accepted, and opens the new trail", async () => {
    const api = mockApi({
      "POST /api/trails": { ...manualDetail, id: "new-id" },
      "GET /api/trails/new-id": { ...manualDetail, id: "new-id" },
    });
    renderRoutes("/trails/new");

    await fillManualForm();
    await userEvent.type(screen.getByLabelText("Highest point (m, optional)"), "1107");
    await userEvent.type(screen.getByLabelText("Description (optional)"), " Lepa ");
    await userEvent.click(screen.getByRole("button", { name: "Create trail" }));

    await waitFor(() => expect(currentLocation()).toBe("/trails/new-id"));
    expect(api.bodyOf("POST /api/trails")).toEqual({
      name: "Krim",
      description: "Lepa",
      distance_m: 4200,
      elevation_gain_m: 350,
      highest_point_m: 1107,
      visibility: "private",
    });
  });

  it("sends empty optional fields as null", async () => {
    const api = mockApi({
      "POST /api/trails": { ...manualDetail, id: "new-id" },
      "GET /api/trails/new-id": { ...manualDetail, id: "new-id" },
    });
    renderRoutes("/trails/new");

    await fillManualForm("10", "0");
    await userEvent.click(screen.getByRole("button", { name: "Create trail" }));

    await waitFor(() => expect(api.bodyOf("POST /api/trails")).toBeTruthy());
    expect(api.bodyOf("POST /api/trails")).toMatchObject({
      distance_m: 10000,
      elevation_gain_m: 0,
      description: null,
      highest_point_m: null,
    });
  });

  it.each([
    ["-3", "100", /Enter a distance/],
    ["0", "100", /Enter a distance/],
    ["far", "100", /Enter a distance/],
    ["", "100", /Enter a distance/],
    ["10001", "100", /Enter a distance/],
    ["3", "-1", /Enter the elevation gain/],
    ["3", "1.5", /Enter the elevation gain/],
    ["3", "", /Enter the elevation gain/],
  ])("does not send distance %j and gain %j", async (km, gain, message) => {
    const api = mockApi({});
    renderRoutes("/trails/new");
    await userEvent.type(screen.getByLabelText("Name"), "Krim");
    if (km) await userEvent.type(screen.getByLabelText("Distance (km)"), km);
    if (gain) await userEvent.type(screen.getByLabelText("Elevation gain (m)"), gain);

    await userEvent.click(screen.getByRole("button", { name: "Create trail" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(message);
    expect(api.requests).toEqual([]);
  });

  it("requires a name that is not just spaces", async () => {
    const api = mockApi({});
    renderRoutes("/trails/new");
    await userEvent.type(screen.getByLabelText("Name"), "   ");
    await userEvent.type(screen.getByLabelText("Distance (km)"), "1");
    await userEvent.type(screen.getByLabelText("Elevation gain (m)"), "1");

    await userEvent.click(screen.getByRole("button", { name: "Create trail" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Enter a name.");
    expect(api.requests).toEqual([]);
  });

  it("rejects a highest point out of range", async () => {
    const api = mockApi({});
    renderRoutes("/trails/new");
    await fillManualForm();
    await userEvent.type(screen.getByLabelText("Highest point (m, optional)"), "9001");

    await userEvent.click(screen.getByRole("button", { name: "Create trail" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/highest point/);
    expect(api.requests).toEqual([]);
  });

  it("explains a taken name in the user's language and stays on the form", async () => {
    mockApi({ "POST /api/trails": { status: 409, body: { detail: "trail_name_taken" } } });
    await i18n.changeLanguage("sl");
    renderRoutes("/trails/new");

    await userEvent.type(screen.getByLabelText("Ime"), "Krim");
    await userEvent.type(screen.getByLabelText("Dolžina (km)"), "1");
    await userEvent.type(screen.getByLabelText("Skupni vzpon (m)"), "1");
    await userEvent.click(screen.getByRole("button", { name: "Ustvari pot" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Pot s tem imenom tukaj že obstaja",
    );
    expect(currentLocation()).toBe("/trails/new");
  });

  it("shares with a chosen group, and requires choosing one", async () => {
    const api = mockApi({
      "GET /api/groups?scope=mine&limit=200": page([
        { id: "g1", name: "Planinci" },
        { id: "g2", name: "Sosedje" },
      ]),
      "POST /api/trails": { ...manualDetail, id: "new-id" },
      "GET /api/trails/new-id": { ...manualDetail, id: "new-id" },
    });
    renderRoutes("/trails/new");
    await fillManualForm();
    await userEvent.selectOptions(screen.getByLabelText("Who can see it"), "Group");

    await userEvent.click(screen.getByRole("button", { name: "Create trail" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Choose a group.");
    expect(api.bodyOf("POST /api/trails")).toBeUndefined();

    await userEvent.selectOptions(await screen.findByLabelText("Group"), "Sosedje");
    await userEvent.click(screen.getByRole("button", { name: "Create trail" }));

    await waitFor(() => expect(currentLocation()).toBe("/trails/new-id"));
    expect(api.bodyOf("POST /api/trails")).toMatchObject({ visibility: "group", group_id: "g2" });
  });

  it("does not load groups unless sharing with one", async () => {
    const api = mockApi({});
    renderRoutes("/trails/new");
    await screen.findByLabelText("Name");

    expect(api.requests).toEqual([]);
  });

  it("says when the user has no group to share with", async () => {
    mockApi({ "GET /api/groups?scope=mine&limit=200": page([]) });
    renderRoutes("/trails/new");

    await userEvent.selectOptions(screen.getByLabelText("Who can see it"), "Group");

    expect((await screen.findByRole("alert")).textContent).toContain("not a member of any group");
  });

  it("shows an error when groups cannot be loaded", async () => {
    mockApi({ "GET /api/groups?scope=mine&limit=200": { status: 500 } });
    renderRoutes("/trails/new");

    await userEvent.selectOptions(screen.getByLabelText("Who can see it"), "Group");

    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong");
  });
});

describe("editing a trail", () => {
  const editable = { ...manualDetail, can_edit: true, visibility: "private" };

  it("starts from the current values and saves them", async () => {
    const api = mockApi({
      "GET /api/trails/t1": editable,
      "PATCH /api/trails/t1": { ...editable, name: "Novo ime" },
    });
    renderRoutes("/trails/t1/edit");

    const name = await screen.findByLabelText<HTMLInputElement>("Name");
    expect(name.value).toBe("Šmarna gora");
    expect(screen.getByLabelText<HTMLInputElement>("Distance (km)").value).toBe("4.2");
    expect(screen.getByLabelText<HTMLInputElement>("Elevation gain (m)").value).toBe("350");
    expect(screen.getByLabelText<HTMLInputElement>("Highest point (m, optional)").value).toBe(
      "669",
    );

    await userEvent.clear(name);
    await userEvent.type(name, "Novo ime");
    await userEvent.clear(screen.getByLabelText("Highest point (m, optional)"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(currentLocation()).toBe("/trails/t1"));
    expect(api.bodyOf("PATCH /api/trails/t1")).toEqual({
      name: "Novo ime",
      description: "Lepa pot",
      distance_m: 4200,
      elevation_gain_m: 350,
      highest_point_m: null,
      visibility: "private",
    });
  });

  it("does not offer changing the measurements of an imported trail", async () => {
    const api = mockApi({
      "GET /api/trails/t1": { ...osmDetail, can_edit: true },
      "PATCH /api/trails/t1": { ...osmDetail, can_edit: true },
    });
    renderRoutes("/trails/t1/edit");

    await screen.findByLabelText("Name");
    expect(screen.queryByLabelText("Distance (km)")).toBeNull();
    expect(screen.queryByLabelText("Elevation gain (m)")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.bodyOf("PATCH /api/trails/t1")).toBeTruthy());
    expect(api.bodyOf("PATCH /api/trails/t1")).toEqual({
      name: "Šmarna gora",
      description: "Lepa pot",
      visibility: "public",
    });
  });

  it("drops the group when a trail stops being shared with it", async () => {
    const shared = { ...editable, visibility: "group", group_id: "g1", group_name: "Planinci" };
    const api = mockApi({
      "GET /api/trails/t1": shared,
      "GET /api/groups?scope=mine&limit=200": page([{ id: "g1", name: "Planinci" }]),
      "PATCH /api/trails/t1": shared,
    });
    renderRoutes("/trails/t1/edit");

    await screen.findByLabelText("Name");
    await userEvent.selectOptions(screen.getByLabelText("Who can see it"), "Public");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.bodyOf("PATCH /api/trails/t1")).toBeTruthy());
    const body = api.bodyOf("PATCH /api/trails/t1") as Record<string, unknown>;
    expect(body.visibility).toBe("public");
    expect("group_id" in body).toBe(false);
  });

  it("does not show the form to users who cannot edit", async () => {
    mockApi({ "GET /api/trails/t1": { ...manualDetail, can_edit: false } });
    renderRoutes("/trails/t1/edit");

    expect((await screen.findByRole("alert")).textContent).toBe("You are not allowed to do this.");
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it("shows why saving failed", async () => {
    mockApi({
      "GET /api/trails/t1": editable,
      "PATCH /api/trails/t1": { status: 409, body: { detail: "trail_name_taken" } },
    });
    renderRoutes("/trails/t1/edit");

    await screen.findByLabelText("Name");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toContain("already exists");
    expect(currentLocation()).toBe("/trails/t1/edit");
  });
});

const osmHit = {
  relation_id: 7,
  name: "Pot Triglavske Bistrice",
  ref: "T1",
  network: "nwn",
  start_name: "Mojstrana",
  end_name: "Vrata",
  bbox: [13.8, 46.3, 13.9, 46.4],
};

const osmPreview = {
  relation_id: 7,
  name: "Pot Triglavske Bistrice",
  geometry: line,
  distance_m: 11043,
  complete: true,
  member_length_m: 11043,
};

const SEARCH_KEY = "GET /api/trails/osm/search?q=Triglav";

async function searchFor(text = "Triglav") {
  await userEvent.type(await screen.findByLabelText("Name of the hiking route"), text);
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
}

describe("importing from OpenStreetMap", () => {
  it("credits OpenStreetMap from the start", async () => {
    mockApi({});
    renderRoutes("/trails/import");

    expect(await screen.findByRole("link", { name: /OpenStreetMap contributors/ })).toBeTruthy();
  });

  it("searches, previews on the map and imports with the chosen name and visibility", async () => {
    const api = mockApi({
      [SEARCH_KEY]: page([osmHit]),
      "GET /api/trails/osm/7": osmPreview,
      "POST /api/trails/osm/import": { ...osmDetail, id: "imported" },
      "GET /api/trails/imported": { ...osmDetail, id: "imported" },
    });
    renderRoutes("/trails/import");
    await searchFor();

    const results = await screen.findByRole("list", { name: "Search results" });
    expect(within(results).getByText("Pot Triglavske Bistrice")).toBeTruthy();
    expect(within(results).getByText("Mojstrana – Vrata")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Preview Pot Triglavske Bistrice" }));

    const name = await screen.findByLabelText<HTMLInputElement>("Name");
    expect(name.value).toBe("Pot Triglavske Bistrice");
    expect(screen.getByText("Distance: 11 km")).toBeTruthy();
    const map = await screen.findByRole("region", { name: "Map for previewing the route" });
    expect(map.getAttribute("data-points")).toBe("3");
    expect(screen.getByRole("link", { name: "View on OpenStreetMap" }).getAttribute("href")).toBe(
      "https://www.openstreetmap.org/relation/7",
    );

    await userEvent.clear(name);
    await userEvent.type(name, "Moja pot");
    await userEvent.selectOptions(screen.getByLabelText("Who can see it"), "Public");
    await userEvent.click(screen.getByRole("button", { name: "Import trail" }));

    await waitFor(() => expect(currentLocation()).toBe("/trails/imported"));
    expect(api.bodyOf("POST /api/trails/osm/import")).toEqual({
      relation_id: 7,
      name: "Moja pot",
      visibility: "public",
    });
  });

  it("restricts the search to the visible map area on request", async () => {
    const api = mockApi({
      "GET /api/trails/osm/search?q=Krim&bbox=13.5%2C45.5%2C14.5%2C46.5": page([]),
    });
    renderRoutes("/trails/import");
    const onlyVisible = await screen.findByLabelText<HTMLInputElement>(
      "Only in the visible map area",
    );
    // Not before the map has loaded and reported its area
    expect(onlyVisible.disabled).toBe(true);

    await userEvent.click(await screen.findByRole("button", { name: "report map area" }));
    await userEvent.click(onlyVisible);
    await searchFor("Krim");

    expect(await screen.findByText(/No hiking routes found/)).toBeTruthy();
    expect(api.requests).toHaveLength(1);
  });

  it("says when nothing was found", async () => {
    mockApi({ [SEARCH_KEY]: page([]) });
    renderRoutes("/trails/import");

    await searchFor();

    expect(await screen.findByText(/No hiking routes found/)).toBeTruthy();
  });

  it("does not search with fewer than two characters", async () => {
    const api = mockApi({});
    renderRoutes("/trails/import");

    await searchFor("x");

    expect((await screen.findByRole("alert")).textContent).toBe("Enter at least two characters.");
    expect(api.requests).toEqual([]);
  });

  it("explains when OpenStreetMap is unavailable, without retrying on its own", async () => {
    const api = mockApi({ [SEARCH_KEY]: { status: 503, body: { detail: "osm_unavailable" } } });
    renderRoutes("/trails/import");

    await searchFor();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "OpenStreetMap search is not available",
    );
    expect(api.requests).toHaveLength(1);
  });

  it("explains a route that has no geometry", async () => {
    mockApi({
      [SEARCH_KEY]: page([osmHit]),
      "GET /api/trails/osm/7": {
        status: 422,
        body: { detail: "osm_route_without_geometry" },
      },
    });
    renderRoutes("/trails/import");
    await searchFor();

    await userEvent.click(
      await screen.findByRole("button", { name: "Preview Pot Triglavske Bistrice" }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain("cannot be imported");
    expect(screen.queryByRole("button", { name: "Import trail" })).toBeNull();
  });

  it("warns when only part of a route can be used", async () => {
    mockApi({
      [SEARCH_KEY]: page([osmHit]),
      "GET /api/trails/osm/7": {
        ...osmPreview,
        distance_m: 8000,
        complete: false,
        member_length_m: 11000,
      },
    });
    renderRoutes("/trails/import");
    await searchFor();

    await userEvent.click(
      await screen.findByRole("button", { name: "Preview Pot Triglavske Bistrice" }),
    );

    expect((await screen.findByRole("note")).textContent).toContain("8 km of 11 km");
  });

  it("requires a name for a route that has none in OpenStreetMap", async () => {
    const api = mockApi({
      [SEARCH_KEY]: page([{ ...osmHit, name: null }]),
      "GET /api/trails/osm/7": { ...osmPreview, name: null },
    });
    renderRoutes("/trails/import");
    await searchFor();

    await userEvent.click(await screen.findByRole("button", { name: "Preview Unnamed route" }));
    await screen.findByLabelText("Name");
    await userEvent.click(screen.getByRole("button", { name: "Import trail" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Enter a name.");
    expect(api.bodyOf("POST /api/trails/osm/import")).toBeUndefined();
  });

  it("shares an import with a group", async () => {
    const api = mockApi({
      [SEARCH_KEY]: page([osmHit]),
      "GET /api/trails/osm/7": osmPreview,
      "GET /api/groups?scope=mine&limit=200": page([{ id: "g1", name: "Planinci" }]),
      "POST /api/trails/osm/import": { ...osmDetail, id: "imported" },
      "GET /api/trails/imported": { ...osmDetail, id: "imported" },
    });
    renderRoutes("/trails/import");
    await searchFor();
    await userEvent.click(
      await screen.findByRole("button", { name: "Preview Pot Triglavske Bistrice" }),
    );
    await screen.findByLabelText("Name");

    await userEvent.selectOptions(screen.getByLabelText("Who can see it"), "Group");
    await userEvent.click(screen.getByRole("button", { name: "Import trail" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Choose a group.");

    await userEvent.selectOptions(await screen.findByLabelText("Group"), "Planinci");
    await userEvent.click(screen.getByRole("button", { name: "Import trail" }));

    await waitFor(() => expect(currentLocation()).toBe("/trails/imported"));
    expect(api.bodyOf("POST /api/trails/osm/import")).toMatchObject({
      visibility: "group",
      group_id: "g1",
    });
  });

  it("shows why an import failed", async () => {
    mockApi({
      [SEARCH_KEY]: page([osmHit]),
      "GET /api/trails/osm/7": osmPreview,
      "POST /api/trails/osm/import": { status: 409, body: { detail: "trail_name_taken" } },
    });
    renderRoutes("/trails/import");
    await searchFor();
    await userEvent.click(
      await screen.findByRole("button", { name: "Preview Pot Triglavske Bistrice" }),
    );
    await screen.findByLabelText("Name");

    await userEvent.click(screen.getByRole("button", { name: "Import trail" }));

    expect((await screen.findByRole("alert")).textContent).toContain("already exists");
    expect(currentLocation()).toBe("/trails/import");
  });
});

describe("elevation chart", () => {
  const profile: [number, number][] = [
    [0, 1000],
    [2500, 1800],
    [5000, 1200],
  ];

  it("has an accessible name and a text summary of the numbers", () => {
    render(<ElevationChart profile={profile} />);

    const chart = screen.getByRole("img", { name: "Elevation profile" });
    const summary = document.getElementById(chart.getAttribute("aria-describedby")!);

    expect(summary?.textContent).toBe(
      "Over 5 km: starts at 1,000 m and ends at 1,200 m, with a lowest point of 1,000 m and a highest point of 1,800 m.",
    );
  });

  it("reports the trail's highest point when smoothing has lowered it in the profile", () => {
    render(<ElevationChart profile={profile} highestPoint={1864} />);

    expect(screen.getByText(/a highest point of 1,864 m/)).toBeTruthy();
  });

  it("labels both axes in the user's language", async () => {
    await i18n.changeLanguage("sl");
    render(<ElevationChart profile={profile} />);

    expect(screen.getByText("Razdalja (km)")).toBeTruthy();
    expect(screen.getByText("Višina (m)")).toBeTruthy();
  });

  it("draws the line through every point, higher elevations further up", () => {
    const { container } = render(<ElevationChart profile={profile} />);

    const path = container.querySelector(".elevation-line")!.getAttribute("d")!;
    const points = path
      .slice(1)
      .split(" L")
      .map((point) => point.split(",").map(Number));

    expect(points).toHaveLength(3);
    expect(points[0][0]).toBeLessThan(points[1][0]);
    expect(points[1][0]).toBeLessThan(points[2][0]);
    // SVG's y axis points down.
    expect(points[1][1]).toBeLessThan(points[2][1]);
    expect(points[2][1]).toBeLessThan(points[0][1]);
    points.flat().forEach((value) => expect(Number.isFinite(value)).toBe(true));
  });

  it("shows the values under the pointer and hides them when it leaves", () => {
    render(<ElevationChart profile={profile} />);
    const hitArea = screen.getByTestId("elevation-hit-area");
    hitArea.getBoundingClientRect = () =>
      ({ left: 100, width: 500, top: 0, height: 100 }) as DOMRect;

    fireEvent.pointerMove(hitArea, { clientX: 350 });
    expect(screen.getByRole("status").textContent).toBe("2.5 km · 1,800 m");

    fireEvent.pointerLeave(hitArea);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("copes with a flat route", () => {
    const { container } = render(
      <ElevationChart
        profile={[
          [0, 500],
          [1000, 500],
        ]}
      />,
    );

    const path = container.querySelector(".elevation-line")!.getAttribute("d")!;
    expect(path).not.toContain("NaN");
    expect(path).not.toContain("Infinity");
  });

  it("draws nothing without at least two points", () => {
    const { container } = render(<ElevationChart profile={[[0, 500]]} />);

    expect(container.querySelector("svg")).toBeNull();
  });

  it("chooses round ticks", () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(980, 1320, 4)).toEqual([1000, 1100, 1200, 1300]);
    expect(niceTicks(0, 0.5, 2)).toEqual([0, 0.5]);
  });
});
