import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeHike, me, page } from "../features/hikes/fixtures";
import { toDateInput } from "../features/hikes/localTime";
import { periodRange } from "../features/stats/period";
import { withQuery } from "../lib/api";
import { mockApi } from "../test/mockApi";
import { render } from "../test/render";
import { HomePage } from "./HomePage";

vi.mock("../auth/hanko", () => ({
  getHanko: () => new Promise(() => undefined),
  getSessionToken: () => "token",
  isHankoConfigured: true,
}));

const totals = {
  hike_count: 6,
  total_distance_m: 25_000,
  total_elevation_gain_m: 1_000,
  total_duration_s: 3_600,
  average_duration_s: 600,
};
const RECENT = "GET /api/hikes?limit=5&offset=0";

function thisYearUrl() {
  const range = periodRange({ kind: "year", date: toDateInput(new Date()) });
  return `GET /api${withQuery("/stats/me", { ...range })}`;
}

describe("HomePage", () => {
  it("shows this year's totals, recent hikes and a way to record", async () => {
    const api = mockApi({
      "GET /api/me": me,
      [thisYearUrl()]: totals,
      [RECENT]: page([makeHike()]),
    });
    render(<HomePage />);

    expect(await screen.findByRole("heading", { name: "Welcome, Marko" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Triglav" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("6")).toBeTruthy());
    expect(screen.getByRole("heading", { name: "This year" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Record a hike" }).getAttribute("href")).toBe(
      "/hikes/new",
    );
    expect(screen.getByRole("link", { name: "All my hikes" }).getAttribute("href")).toBe("/hikes");
    expect(api.requests.map((request) => request.key)).toContain(thisYearUrl());
  });

  it("invites a new user to record their first hike", async () => {
    mockApi({
      "GET /api/me": me,
      [thisYearUrl()]: { ...totals, hike_count: 0 },
      [RECENT]: page([]),
    });
    render(<HomePage />);

    expect(await screen.findByText("You have no recorded hikes yet.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "All my hikes" })).toBeNull();
  });

  it("suggests choosing a name while it is still the default", async () => {
    mockApi({
      "GET /api/me": { ...me, display_name: "Hiker" },
      [thisYearUrl()]: totals,
      [RECENT]: page([]),
    });
    render(<HomePage />);

    const prompt = await screen.findByRole("link", { name: /Choose your own name/ });
    expect(prompt.getAttribute("href")).toBe("/profile");
  });

  it("doesn't suggest a name to someone who has chosen one", async () => {
    mockApi({ "GET /api/me": me, [thisYearUrl()]: totals, [RECENT]: page([]) });
    render(<HomePage />);

    expect(await screen.findByRole("heading", { name: "Welcome, Marko" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Choose your own name/ })).toBeNull();
  });

  it("shows an error without losing the rest of the page", async () => {
    mockApi({
      "GET /api/me": me,
      [thisYearUrl()]: { status: 500 },
      [RECENT]: page([makeHike()]),
    });
    render(<HomePage />);

    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong");
    expect(await screen.findByRole("heading", { name: "Triglav" })).toBeTruthy();
  });
});
