import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../auth/AuthContext";
import { mockApi } from "../../test/mockApi";
import { render } from "../../test/render";
import { InvitationPage } from "./InvitationPage";

vi.mock("../../auth/hanko", () => ({
  getHanko: () => new Promise(() => undefined),
  getSessionToken: () => "token",
  isHankoConfigured: true,
}));

const url = "/api/groups/invitations/tok";
const valid = {
  email_matches: true,
  group_id: "g1",
  group_name: "Hikers",
  inviter_name: "Ana",
  expires_at: "2030-01-08T10:00:00Z",
};
const mismatch = {
  email_matches: false,
  group_id: null,
  group_name: null,
  inviter_name: null,
  expires_at: "2030-01-08T10:00:00Z",
};
const me = { id: "u1", email: "me@example.com", display_name: "Me" };

const routes = (
  <Routes>
    <Route path="/invitations/:token" element={<InvitationPage />} />
    <Route path="/groups/:id" element={<p>Group page</p>} />
  </Routes>
);

function renderPage() {
  return render(routes, { route: "/invitations/tok" });
}

describe("InvitationPage", () => {
  it("shows who invited the user to which group", async () => {
    mockApi({ [`GET ${url}`]: valid });
    renderPage();

    expect(await screen.findByText("Ana invited you to join the group Hikers.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
  });

  it("works without an inviter, whose account may be gone", async () => {
    mockApi({ [`GET ${url}`]: { ...valid, inviter_name: null } });
    renderPage();

    expect(await screen.findByText("You are invited to join the group Hikers.")).toBeTruthy();
  });

  it("accepting opens the group", async () => {
    const api = mockApi({
      [`GET ${url}`]: valid,
      [`POST ${url}/accept`]: { id: "g1", name: "Hikers" },
    });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));

    expect(await screen.findByText("Group page")).toBeTruthy();
    expect(api.requests.map((request) => request.key)).toContain(`POST ${url}/accept`);
  });

  it("declining says so and stops asking", async () => {
    mockApi({ [`GET ${url}`]: valid, [`POST ${url}/decline`]: { status: 204 } });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Decline" }));

    expect(await screen.findByText("You declined the invitation.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.getByRole("link", { name: "All groups" })).toBeTruthy();
  });

  it.each([
    [410, "invitation_expired", "This invitation has expired."],
    [410, "invitation_revoked", "This invitation has been revoked."],
    [409, "invitation_already_used", "This invitation has already been used."],
    [404, "invitation_not_found", "This invitation link is not valid."],
  ])("shows a clear state for %i %s", async (status, detail, text) => {
    mockApi({ [`GET ${url}`]: { status, body: { detail } } });
    renderPage();

    expect((await screen.findByRole("alert")).textContent).toContain(text);
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.getByRole("link", { name: "All groups" })).toBeTruthy();
  });

  it("tells someone in a different account, without any way to accept", async () => {
    mockApi({ [`GET ${url}`]: mismatch, "GET /api/me": me });
    renderPage();

    expect((await screen.findByRole("alert")).textContent).toContain("different e-mail address");
    expect(await screen.findByText("You are signed in as me@example.com.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
  });

  it("lets someone in a different account switch", async () => {
    mockApi({ [`GET ${url}`]: mismatch, "GET /api/me": me });
    const logout = vi.fn(async () => undefined);
    rtlRender(
      <QueryClientProvider client={new QueryClient()}>
        <AuthContext.Provider value={{ status: "authenticated", logout }}>
          <MemoryRouter initialEntries={["/invitations/tok"]}>{routes}</MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Sign in with another account" }),
    );

    await waitFor(() => expect(logout).toHaveBeenCalled());
  });

  it("shows what went wrong when accepting fails", async () => {
    mockApi({
      [`GET ${url}`]: valid,
      [`POST ${url}/accept`]: { status: 410, body: { detail: "invitation_expired" } },
    });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));

    expect((await screen.findByRole("alert")).textContent).toContain("has expired");
  });
});
