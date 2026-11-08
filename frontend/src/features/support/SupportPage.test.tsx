import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { mockApi } from "../../test/mockApi";
import { render } from "../../test/render";
import { SupportLink } from "./SupportLink";
import { SupportPage } from "./SupportPage";

vi.mock("../../auth/hanko", () => ({
  getHanko: () => new Promise(() => undefined),
  getSessionToken: () => null,
  isHankoConfigured: true,
}));

const bankTransfer = {
  iban: "SI56 0201 7001 4356 205",
  name: "Marko Planinec",
  street: null,
  city: "1000 Ljubljana",
  purpose: "Donacija TrailStat.si",
  reference: "SI99",
};
const flik = { number: "041 123 456", message: "Donacija TrailStat.si" };
const details = { bank_transfer: bankTransfer, flik: null };

const qrImage = () => screen.getByRole<HTMLImageElement>("img", { name: /UPN QR/ });

describe("SupportPage", () => {
  afterEach(() => i18n.changeLanguage("en"));

  it("shows a UPN QR code for the chosen amount, and the details to type in", async () => {
    mockApi({ "GET /api/donations": details });
    render(<SupportPage />, { auth: "anonymous" });

    expect(await screen.findByText("SI56 0201 7001 4356 205")).toBeTruthy();
    expect(screen.getByText("Marko Planinec", { exact: false })).toBeTruthy();
    expect(screen.getByText("SI99")).toBeTruthy();
    // €10 is chosen at first.
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "€10" }).checked).toBe(true);
    expect(qrImage().getAttribute("src")).toBe("/api/donations/upn-qr.svg?amount_cents=1000");
    expect(qrImage().alt).toBe("UPN QR code for a donation of €10");

    await userEvent.click(screen.getByRole("radio", { name: "€20" }));
    expect(qrImage().getAttribute("src")).toBe("/api/donations/upn-qr.svg?amount_cents=2000");

    await userEvent.click(screen.getByRole("radio", { name: "Your choice" }));
    expect(qrImage().getAttribute("src")).toBe("/api/donations/upn-qr.svg");
    expect(qrImage().alt).toBe("UPN QR code for a donation, without an amount");
  });

  it("shows the Flik number, which can be copied", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    mockApi({ "GET /api/donations": { bank_transfer: bankTransfer, flik } });
    render(<SupportPage />);

    expect(await screen.findByRole("heading", { name: "Send with Flik" })).toBeTruthy();
    expect(screen.getByText("041 123 456")).toBeTruthy();
    expect(screen.getByText(/add “Donacija TrailStat.si” as the message/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Copy number" }));
    expect(writeText).toHaveBeenCalledWith("041123456");
    expect(await screen.findByText("Number copied.")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("offers Flik alone, without a QR code, when there is no bank account", async () => {
    mockApi({ "GET /api/donations": { bank_transfer: null, flik } });
    render(<SupportPage />);

    expect(await screen.findByText("041 123 456")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("IBAN")).toBeNull();
  });

  it("works whatever language the browser reports", async () => {
    mockApi({ "GET /api/donations": details });
    // Not a valid locale: number formatting must use the language the app resolved to.
    await i18n.changeLanguage("C");
    render(<SupportPage />);

    expect(await screen.findByRole("radio", { name: "€10" })).toBeTruthy();
  });

  it("says so when donations are off", async () => {
    mockApi({ "GET /api/donations": { status: 404, body: { detail: "donations_off" } } });
    render(<SupportPage />);

    expect(await screen.findByText("Donations are not open at the moment.")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("formats amounts in the user's language", async () => {
    mockApi({ "GET /api/donations": details });
    await i18n.changeLanguage("sl");
    render(<SupportPage />);

    expect(await screen.findByRole("radio", { name: /^5\s€$/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Po vaši izbiri" })).toBeTruthy();
  });
});

describe("SupportLink", () => {
  it("links to the support page when donations are open", async () => {
    mockApi({ "GET /api/donations": details });
    render(<SupportLink />);

    const link = await screen.findByRole("link", { name: "Support TrailStat.si" });
    expect(link.getAttribute("href")).toBe("/support");
  });

  it("is hidden when donations are off", async () => {
    const api = mockApi({
      "GET /api/donations": { status: 404, body: { detail: "donations_off" } },
    });
    render(<SupportLink />);

    await vi.waitFor(() => expect(api.requests).toHaveLength(1));
    expect(screen.queryByRole("link")).toBeNull();
  });
});
