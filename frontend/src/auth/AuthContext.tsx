import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { UNAUTHORIZED_EVENT } from "../lib/api";
import { getHanko, isHankoConfigured } from "./hanko";

export type AuthStatus = "loading" | "authenticated" | "anonymous" | "unconfigured";

interface AuthContextValue {
  status: AuthStatus;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>(isHankoConfigured ? "loading" : "unconfigured");

  const signedOut = useCallback(() => {
    setStatus("anonymous");
    // The next user on this device must not see cached data of the previous one.
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    if (!isHankoConfigured) return;
    let active = true;
    const cleanups: (() => void)[] = [];

    void getHanko()
      .then(async (hanko) => {
        if (!active) return;
        cleanups.push(
          hanko.onSessionCreated(() => setStatus("authenticated")),
          hanko.onSessionExpired(signedOut),
          hanko.onUserLoggedOut(signedOut),
          hanko.onUserDeleted(signedOut),
        );
        const session = await hanko.validateSession();
        if (active) setStatus(session.is_valid ? "authenticated" : "anonymous");
      })
      .catch(() => {
        if (active) setStatus("anonymous");
      });

    window.addEventListener(UNAUTHORIZED_EVENT, signedOut);
    return () => {
      active = false;
      cleanups.forEach((cleanup) => cleanup());
      window.removeEventListener(UNAUTHORIZED_EVENT, signedOut);
    };
  }, [signedOut]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      logout: async () => {
        const hanko = await getHanko();
        await hanko.logout();
      },
    }),
    [status],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
