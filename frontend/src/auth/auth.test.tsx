import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UNAUTHORIZED_EVENT } from "../lib/api";
import { AuthProvider, useAuth } from "./AuthContext";
import { LoginPage } from "./LoginPage";
import { RequireAuth } from "./RequireAuth";

const hanko = vi.hoisted(() => {
  const listeners: Record<string, () => void> = {};
  const on = (name: string) => (callback: () => void) => {
    listeners[name] = callback;
    return () => delete listeners[name];
  };
  return {
    listeners,
    validateSession: vi.fn(),
    logout: vi.fn(),
    onSessionCreated: on("created"),
    onSessionExpired: on("expired"),
    onUserLoggedOut: on("loggedOut"),
    onUserDeleted: on("deleted"),
  };
});

vi.mock("./hanko", () => ({
  isHankoConfigured: true,
  getHanko: () => Promise.resolve(hanko),
  getSessionToken: () => "token",
}));

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

function Secret() {
  const { logout } = useAuth();
  return <button onClick={() => void logout()}>secret content</button>;
}

function renderApp(route: string) {
  const queryClient = new QueryClient();
  const clear = vi.spyOn(queryClient, "clear");
  rtlRender(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={[route]}>
          <Where />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<RequireAuth />}>
              <Route path="/trails" element={<Secret />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { clear };
}

beforeEach(() => {
  hanko.validateSession.mockReset();
  hanko.logout.mockReset();
});

describe("authentication flow", () => {
  it("shows protected content with a valid session", async () => {
    hanko.validateSession.mockResolvedValue({ is_valid: true });
    renderApp("/trails");

    expect(await screen.findByText("secret content")).toBeTruthy();
  });

  it("sends anonymous visitors to login, then back where they wanted to go", async () => {
    hanko.validateSession.mockResolvedValue({ is_valid: false });
    renderApp("/trails?q=bled");

    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/login"));
    expect(screen.queryByText("secret content")).toBeNull();

    act(() => hanko.listeners.created());

    expect(await screen.findByText("secret content")).toBeTruthy();
    expect(screen.getByTestId("where").textContent).toBe("/trails?q=bled");
  });

  it("treats a failing session check as signed out", async () => {
    hanko.validateSession.mockRejectedValue(new Error("network"));
    renderApp("/trails");

    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/login"));
  });

  it.each(["expired", "loggedOut", "deleted"])(
    "signs out and clears cached data when Hanko reports %s",
    async (event) => {
      hanko.validateSession.mockResolvedValue({ is_valid: true });
      const { clear } = renderApp("/trails");
      await screen.findByText("secret content");

      act(() => hanko.listeners[event]());

      await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/login"));
      expect(clear).toHaveBeenCalled();
    },
  );

  it("signs out when the API rejects the session", async () => {
    hanko.validateSession.mockResolvedValue({ is_valid: true });
    renderApp("/trails");
    await screen.findByText("secret content");

    act(() => void window.dispatchEvent(new Event(UNAUTHORIZED_EVENT)));

    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/login"));
  });

  it("logs out through Hanko", async () => {
    hanko.validateSession.mockResolvedValue({ is_valid: true });
    renderApp("/trails");

    await userEvent.click(await screen.findByText("secret content"));

    expect(hanko.logout).toHaveBeenCalledOnce();
  });
});
