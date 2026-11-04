import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withQuery } from "../../lib/api";
import { mockApi } from "../../test/mockApi";
import { render } from "../../test/render";
import { makeHike, page } from "../hikes/fixtures";
import type { Totals } from "./api";
import { StatsPage } from "./StatsPage";

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

const GROUPS = "GET /api/groups?scope=mine&limit=200";
const group = { id: "g1", name: "Planinci", is_member: true };

function totals(fields: Partial<Totals> = {}): Totals {
  return {
    hike_count: 3,
    total_distance_m: 25_000,
    total_elevation_gain_m: 1_000,
    total_duration_s: 12_600,
    average_duration_s: 4_200,
    ...fields,
  };
}

const ZERO = totals({
  hike_count: 0,
  total_distance_m: 0,
  total_elevation_gain_m: 0,
  total_duration_s: 0,
  average_duration_s: 0,
});

function statsUrl(path: string, start_from?: string, start_to?: string) {
  return `GET /api${withQuery(path, { start_from, start_to })}`;
}

function hikesUrl(path: string, start_from?: string, start_to?: string) {
  return `GET /api${withQuery(path, { start_from, start_to, limit: 20, offset: 0 })}`;
}

function tile(label: string): string | null | undefined {
  const title = screen.queryAllByText(label).find((element) => element.tagName === "DT");
  return title?.closest("div")?.querySelector("dd")?.textContent;
}

const allTime = {
  [GROUPS]: page([group]),
  [statsUrl("/stats/me")]: totals(),
  [hikesUrl("/hikes")]: page([makeHike()]),
};

async function selectPeriod(kind: string) {
  await userEvent.selectOptions(await screen.findByLabelText("Period"), kind);
}

describe("personal statistics", () => {
  it("shows all-time totals as tiles, and the hikes", async () => {
    mockApi(allTime);
    render(<StatsPage />);

    await screen.findByRole("heading", { name: "Triglav" });
    expect(tile("Hikes")).toBe("3");
    expect(tile("Total distance")).toBe("25 km");
    expect(tile("Total elevation gain")).toBe("1,000 m");
    expect(tile("Total time")).toMatch(/^3\D+30\D+$/);
    expect(tile("Average time")).toMatch(/^1\D+10\D+$/);
    // No breakdown for one person.
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("formats with the current language", async () => {
    const { default: i18n } = await import("../../i18n");
    await i18n.changeLanguage("sl");
    mockApi({ ...allTime, [statsUrl("/stats/me")]: totals({ total_distance_m: 25_500 }) });
    render(<StatsPage />);

    await screen.findByRole("heading", { name: "Triglav" });
    expect(tile("Pohodi")).toBe("3");
    expect(tile("Skupna razdalja")?.replace(/\s/g, " ")).toBe("25,5 km");
  });

  it("shows an empty state", async () => {
    mockApi({
      ...allTime,
      [statsUrl("/stats/me")]: ZERO,
      [hikesUrl("/hikes")]: page([]),
    });
    render(<StatsPage />);

    expect(await screen.findByText("No hikes in this period.")).toBeTruthy();
    expect(tile("Hikes")).toBe("0");
    expect(tile("Average time")).toMatch(/^0\D+$/);
  });

  it("shows an error when statistics fail", async () => {
    mockApi({ ...allTime, [statsUrl("/stats/me")]: { status: 500 } });
    render(<StatsPage />);
    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong");
  });

  it("a day spanning the switch to summer time is 23 local hours", async () => {
    const start = "2024-03-30T23:00:00.000Z";
    const end = "2024-03-31T22:00:00.000Z";
    const api = mockApi({
      ...allTime,
      [statsUrl("/stats/me", start, end)]: totals({ hike_count: 7 }),
      [hikesUrl("/hikes", start, end)]: page([]),
    });
    render(<StatsPage />);

    await selectPeriod("day");
    fireEvent.change(screen.getByLabelText("Day", { selector: "input" }), {
      target: { value: "2024-03-31" },
    });

    await waitFor(() => expect(tile("Hikes")).toBe("7"));
    expect(api.requests.map((request) => request.key)).toContain(hikesUrl("/hikes", start, end));
  });

  it("a month spanning the switch back to winter time ends on local midnight", async () => {
    const start = "2024-09-30T22:00:00.000Z";
    const end = "2024-10-31T23:00:00.000Z";
    mockApi({
      ...allTime,
      [statsUrl("/stats/me", start, end)]: totals({ hike_count: 8 }),
      [hikesUrl("/hikes", start, end)]: page([]),
    });
    render(<StatsPage />);

    await selectPeriod("month");
    const year = await screen.findByLabelText("Year");
    fireEvent.change(year, { target: { value: "2024" } });
    await userEvent.selectOptions(screen.getByLabelText("Month"), "October");

    await waitFor(() => expect(tile("Hikes")).toBe("8"));
  });

  it("a year runs between local new years, and a half-typed year is ignored", async () => {
    const start = "2023-12-31T23:00:00.000Z";
    const end = "2024-12-31T23:00:00.000Z";
    const api = mockApi({
      ...allTime,
      [statsUrl("/stats/me", start, end)]: totals({ hike_count: 9 }),
      [hikesUrl("/hikes", start, end)]: page([]),
    });
    render(<StatsPage />);

    await selectPeriod("year");
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "20" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Nothing is requested for the year 20, which the Date constructor would read as 1920.
    expect(api.requests.filter((request) => /start_from=(00|19)/.test(request.key))).toEqual([]);
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2024" } });

    await waitFor(() => expect(tile("Hikes")).toBe("9"));
  });

  it("clearing the day keeps the selected day", async () => {
    mockApi(allTime);
    render(<StatsPage />);
    await selectPeriod("day");
    const input = screen.getByLabelText<HTMLInputElement>("Day", { selector: "input" });
    const selected = input.value;
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe(selected);
  });

  it("going back to all time removes the bounds", async () => {
    const api = mockApi(allTime);
    render(<StatsPage />);

    await selectPeriod("year");
    await selectPeriod("all");

    await waitFor(() => expect(tile("Hikes")).toBe("3"));
    expect(api.requests.at(-1)?.key).not.toContain("start_from");
  });
});

describe("group statistics", () => {
  const groupStats = {
    totals: totals({ hike_count: 2 }),
    attendees: [
      {
        user_id: "ana",
        guest_id: null,
        name: "Ana",
        totals: totals({
          hike_count: 2,
          total_distance_m: 18_000,
          total_elevation_gain_m: 800,
          total_duration_s: 9_000,
          average_duration_s: 4_500,
        }),
      },
      {
        user_id: null,
        guest_id: "jure",
        name: "Jure",
        totals: totals({ hike_count: 1, total_distance_m: 5_000 }),
      },
    ],
  };
  const members = {
    [GROUPS]: page([group]),
    "GET /api/groups/g1": group,
    [statsUrl("/stats/groups/g1")]: groupStats,
    [hikesUrl("/groups/g1/hikes")]: page([makeHike({ group_id: "g1", group_name: "Planinci" })]),
  };

  it("opens directly from the URL, with the breakdown table", async () => {
    mockApi(members);
    render(<StatsPage />, { route: "/stats?group=g1" });

    const table = await screen.findByRole("table");
    expect(table.closest(".table-wrap")).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>("Show statistics for").value).toBe("g1");
    expect(tile("Hikes")).toBe("2");

    const ana = within(table).getByRole("row", { name: /Ana/ });
    expect(ana.textContent).toContain("18 km");
    expect(ana.textContent).toContain("800 m");
    const jure = within(table).getByRole("row", { name: /Jure/ });
    expect(jure.textContent).toContain("Guest");
    expect(ana.textContent).not.toContain("Guest");

    expect(await screen.findByRole("heading", { name: "Triglav" })).toBeTruthy();
  });

  it("applies the period to the totals, breakdown and hikes", async () => {
    const start = "2023-12-31T23:00:00.000Z";
    const end = "2024-12-31T23:00:00.000Z";
    mockApi({
      ...members,
      [statsUrl("/stats/groups/g1", start, end)]: { totals: ZERO, attendees: [] },
      [hikesUrl("/groups/g1/hikes", start, end)]: page([]),
    });
    render(<StatsPage />, { route: "/stats?group=g1" });

    await screen.findByRole("table");
    await selectPeriod("year");
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2024" } });

    await waitFor(() => expect(tile("Hikes")).toBe("0"));
    expect(screen.queryByRole("table")).toBeNull();
    await waitFor(() => expect(screen.getAllByText("No hikes in this period.")).toHaveLength(2));
  });

  it("switches between me and a group", async () => {
    const api = mockApi({ ...allTime, ...members });
    render(<StatsPage />);

    await screen.findByRole("option", { name: "Planinci" });
    await userEvent.selectOptions(screen.getByLabelText("Show statistics for"), "g1");
    await screen.findByRole("table");
    expect(api.requests.map((request) => request.key)).toContain(statsUrl("/stats/groups/g1"));

    await userEvent.selectOptions(screen.getByLabelText("Show statistics for"), "");
    await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
    expect(tile("Hikes")).toBeTruthy();
  });

  it("a non-member of a public group sees only the name and totals", async () => {
    const api = mockApi({
      [GROUPS]: page([]),
      "GET /api/groups/pub": { id: "pub", name: "Javna", is_member: false },
      "GET /api/stats/groups/pub/summary": totals({ hike_count: 4 }),
    });
    render(<StatsPage />, { route: "/stats?group=pub" });

    expect(await screen.findByText(/You aren't a member/)).toBeTruthy();
    await waitFor(() => expect(tile("Hikes")).toBe("4"));
    expect(await screen.findByRole("option", { name: "Javna" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByLabelText("Period")).toBeNull();
    const keys = api.requests.map((request) => request.key);
    expect(keys).not.toContain(statsUrl("/stats/groups/pub"));
    expect(keys).not.toContain(hikesUrl("/groups/pub/hikes"));
  });

  it("a private group is not found for a non-member", async () => {
    mockApi({
      [GROUPS]: page([]),
      "GET /api/groups/priv": { status: 404, body: { detail: "not_found" } },
    });
    render(<StatsPage />, { route: "/stats?group=priv" });
    expect((await screen.findByRole("alert")).textContent).toContain("does not exist");
  });
});
