import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi } from "../../test/mockApi";
import { render } from "../../test/render";
import { AccountData } from "./AccountData";
import { AccountDeletedPage } from "./AccountDeletedPage";
import { PrivacyPage } from "./PrivacyPage";

const hanko = vi.hoisted(() => ({ deleteHankoAccount: vi.fn() }));

vi.mock("../../auth/hanko", () => ({
  getSessionToken: () => "token",
  getLastSessionToken: () => "token",
  isHankoConfigured: true,
  getHanko: () => new Promise(() => undefined),
  deleteHankoAccount: hanko.deleteHankoAccount,
}));

const me = {
  id: "1",
  email: "Marko@example.com",
  display_name: "Marko",
  country: null,
  city: null,
  avatar_url: null,
  locale: "en",
  is_admin: false,
};

function renderIt() {
  render(
    <Routes>
      <Route path="/" element={<AccountData me={me} />} />
      <Route path="/account-deleted" element={<AccountDeletedPage />} />
    </Routes>,
  );
}

async function startDeleting() {
  await userEvent.click(screen.getByRole("button", { name: "Delete my account" }));
  return screen.getByRole("button", { name: "Delete my account permanently" });
}

beforeEach(() => hanko.deleteHankoAccount.mockReset());

describe("AccountData", () => {
  it("downloads the export", async () => {
    mockApi({ "GET /api/me/export": { profile: {} } });
    const createUrl = vi.fn(() => "blob:x");
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }),
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    renderIt();

    await userEvent.click(screen.getByRole("button", { name: "Download my data" }));

    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(createUrl).toHaveBeenCalledOnce();
    click.mockRestore();
  });

  it("does not delete until the e-mail address is typed, in any case", async () => {
    const api = mockApi({ "DELETE /api/me": { status: 204 } });
    hanko.deleteHankoAccount.mockResolvedValue(true);
    renderIt();

    const confirm = await startDeleting();
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByRole("textbox"), "wrong@example.com");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(api.requests).toEqual([]);

    await userEvent.clear(screen.getByRole("textbox"));
    await userEvent.type(screen.getByRole("textbox"), "marko@example.com");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });

  it("deletes our data first, then the login", async () => {
    const order: string[] = [];
    mockApi({ "DELETE /api/me": { status: 204 } });
    const fetchMock = vi.mocked(fetch);
    const realFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (...args: Parameters<typeof fetch>) => {
      order.push("api");
      return realFetch(...(args as [never, never]));
    });
    hanko.deleteHankoAccount.mockImplementation(async () => {
      order.push("hanko");
      return true;
    });
    renderIt();

    const confirm = await startDeleting();
    await userEvent.type(screen.getByRole("textbox"), "marko@example.com");
    await userEvent.click(confirm);

    expect(await screen.findByText("Your account is deleted")).toBeTruthy();
    expect(order).toEqual(["api", "hanko"]);
    expect(screen.queryByText(/could not be deleted automatically/)).toBeNull();
  });

  it("says so when the login could not be deleted", async () => {
    mockApi({ "DELETE /api/me": { status: 204 } });
    hanko.deleteHankoAccount.mockResolvedValue(false);
    renderIt();

    const confirm = await startDeleting();
    await userEvent.type(screen.getByRole("textbox"), "marko@example.com");
    await userEvent.click(confirm);

    expect(await screen.findByText(/could not be deleted automatically/)).toBeTruthy();
  });

  it("keeps the login and shows an error when deleting our data fails", async () => {
    mockApi({ "DELETE /api/me": { status: 500, body: { detail: "internal" } } });
    renderIt();

    const confirm = await startDeleting();
    await userEvent.type(screen.getByRole("textbox"), "marko@example.com");
    await userEvent.click(confirm);

    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong");
    expect(hanko.deleteHankoAccount).not.toHaveBeenCalled();
  });
});

describe("PrivacyPage", () => {
  it("is readable without signing in", () => {
    render(<PrivacyPage />, { auth: "anonymous" });
    expect(screen.getByRole("heading", { name: "Privacy policy" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Your rights" })).toBeTruthy();
  });
});
