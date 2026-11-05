import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { mockApi } from "../test/mockApi";
import { render } from "../test/render";
import { Layout } from "./Layout";

vi.mock("../auth/hanko", () => ({
  getHanko: () => new Promise(() => undefined),
  getSessionToken: () => "token",
  isHankoConfigured: true,
}));

describe("Layout", () => {
  afterEach(() => i18n.changeLanguage("en"));

  it("names the main navigation in the user's language", async () => {
    mockApi({ "GET /api/me": { id: "u1", email: "a@b.si", display_name: "A", locale: null } });
    await i18n.changeLanguage("sl");
    render(<Layout />);

    expect(screen.getByRole("navigation", { name: "Glavna navigacija" })).toBeTruthy();
  });
});
