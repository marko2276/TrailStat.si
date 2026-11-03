import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { AuthContext } from "../auth/AuthContext";
import type { AuthStatus } from "../auth/AuthContext";

interface Options {
  /** Starting URL, e.g. "/trails/1". */
  route?: string;
  auth?: AuthStatus;
}

/** Renders inside the app's providers, signed in by default. No request retries. */
export function render(ui: ReactElement, { route = "/", auth = "authenticated" }: Options = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return rtlRender(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={{ status: auth, logout: async () => undefined }}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}
