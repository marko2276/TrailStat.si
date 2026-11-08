import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { mockApi } from "../../test/mockApi";
import { render } from "../../test/render";
import { AdminLink } from "./AdminLink";
import { AdminPage, formatBytes } from "./AdminPage";
import type { AdminStats } from "./api";

vi.mock("../../auth/hanko", () => ({
  getHanko: () => new Promise(() => undefined),
  getSessionToken: () => "token",
  isHankoConfigured: true,
}));

const me = (isAdmin: boolean) => ({
  id: "u1",
  email: "a@b.si",
  display_name: "A",
  country: null,
  city: null,
  avatar_url: null,
  locale: "en",
  is_admin: isAdmin,
});

const stats: AdminStats = {
  users: {
    total: 1234,
    new_7_days: 5,
    new_30_days: 20,
    active_30_days: 300,
    by_language: { sl: 800, en: 400, unknown: 34 },
  },
  content: {
    trails: 90,
    trails_by_source: { osm: 50, file: 30, manual: 10 },
    trails_by_visibility: { public: 60, private: 30 },
    trails_archived: 3,
    hikes: 410,
    hikes_30_days: 42,
    groups: 12,
    memberships: 70,
    guests: 8,
    pending_invitations: 2,
    pending_join_requests: 1,
  },
  database: {
    size_bytes: 19 * 1024 * 1024,
    largest_tables: [{ name: "trails", size_bytes: 1536, rows_estimate: 90 }],
    migration: "0004",
  },
  server: {
    version: "abc1234",
    environment: "production",
    started_at: "2026-11-08T10:00:00Z",
    today: "2026-11-08",
    elevation_data: { tiles: 12, size_bytes: 484 * 1024 * 1024 },
    email_configured: true,
    donations_bank_transfer: true,
    donations_flik: false,
  },
};

describe("AdminPage", () => {
  it("shows the totals", async () => {
    mockApi({ "GET /api/me": me(true), "GET /api/admin/stats": stats });
    render(<AdminPage />);

    expect(await screen.findByRole("heading", { name: "Admin" })).toBeTruthy();
    expect(screen.getByText("1,234")).toBeTruthy();
    expect(screen.getByText(/Slovenščina 800 · English 400 · unknown 34/)).toBeTruthy();
    expect(screen.getByText(/OpenStreetMap 50 · file 30 · manual 10/)).toBeTruthy();
    expect(screen.getByText("19 MB")).toBeTruthy();
    expect(screen.getByRole("cell", { name: "1.5 kB" })).toBeTruthy();
    expect(screen.getByText("12 tiles, 484 MB")).toBeTruthy();
    expect(screen.getByText("abc1234")).toBeTruthy();
  });

  it("is not there for anyone else", async () => {
    mockApi({
      "GET /api/me": me(false),
      "GET /api/admin/stats": { status: 404, body: { detail: "not_found" } },
    });
    render(<AdminPage />);

    expect(await screen.findByText("This page does not exist.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Admin" })).toBeNull();
  });
});

describe("AdminLink", () => {
  it("is shown to admins", async () => {
    mockApi({ "GET /api/me": me(true) });
    render(<AdminLink />);
    expect((await screen.findByRole("link", { name: "Admin" })).getAttribute("href")).toBe(
      "/admin",
    );
  });

  it("is hidden from everyone else", async () => {
    const api = mockApi({ "GET /api/me": me(false) });
    render(<AdminLink />);
    await vi.waitFor(() => expect(api.requests).toHaveLength(1));
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("formatBytes", () => {
  it("picks a unit", () => {
    expect(formatBytes(512, "en")).toBe("512 byte");
    expect(formatBytes(2048, "en")).toBe("2 kB");
    expect(formatBytes(3 * 1024 ** 3, "sl")).toBe("3 GB");
  });
});
