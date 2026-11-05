import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import i18n, { languageName, supportedLanguages } from "../../i18n";
import { mockApi } from "../../test/mockApi";
import { render } from "../../test/render";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { LanguageSync } from "./LanguageSync";

vi.mock("../../auth/hanko", () => ({ getSessionToken: () => "token", isHankoConfigured: true }));

const me = {
  id: "1",
  email: "a@example.com",
  display_name: "A",
  country: null,
  city: null,
  avatar_url: null,
};

describe("language", () => {
  it("offers English and Slovenian, named in their own language", () => {
    expect(supportedLanguages).toEqual(expect.arrayContaining(["en", "sl"]));
    expect(languageName("sl")).toBe("Slovenščina");
    expect(languageName("en")).toBe("English");
  });

  it("translates the whole app and the document language when switching", async () => {
    await i18n.changeLanguage("sl");

    expect(i18n.t("logout")).toBe("Odjava");
    expect(document.documentElement.lang).toBe("sl");
  });

  it("applies the language stored on the profile", async () => {
    mockApi({ "GET /api/me": { ...me, locale: "sl" } });
    render(<LanguageSync />);

    await waitFor(() => expect(i18n.resolvedLanguage).toBe("sl"));
  });

  it("stores the current language on first sign-in instead of overriding it", async () => {
    await i18n.changeLanguage("sl");
    const api = mockApi({
      "GET /api/me": { ...me, locale: null },
      "PATCH /api/me": { ...me, locale: "sl" },
    });
    render(<LanguageSync />);

    await waitFor(() => expect(api.bodyOf("PATCH /api/me")).toEqual({ locale: "sl" }));
    expect(i18n.resolvedLanguage).toBe("sl");
  });

  it("saves the choice on the profile when signed in", async () => {
    const api = mockApi({ "PATCH /api/me": { ...me, locale: "sl" } });
    render(<LanguageSwitcher />);

    await userEvent.selectOptions(screen.getByRole("combobox"), "sl");

    await waitFor(() => expect(api.bodyOf("PATCH /api/me")).toEqual({ locale: "sl" }));
    expect(i18n.resolvedLanguage).toBe("sl");
  });

  it("does not call the API when signed out", async () => {
    const api = mockApi({});
    render(<LanguageSwitcher />, { auth: "anonymous" });

    await userEvent.selectOptions(screen.getByRole("combobox"), "sl");

    expect(i18n.resolvedLanguage).toBe("sl");
    expect(api.requests).toEqual([]);
  });
});
