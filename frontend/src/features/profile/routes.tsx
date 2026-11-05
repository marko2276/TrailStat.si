import type { RouteObject } from "react-router";
import { AccountDeletedPage } from "./AccountDeletedPage";
import { PrivacyPage } from "./PrivacyPage";
import { ProfilePage } from "./ProfilePage";

export const routes: RouteObject[] = [{ path: "profile", element: <ProfilePage /> }];

/** Readable without an account. */
export const publicRoutes: RouteObject[] = [
  { path: "privacy", element: <PrivacyPage /> },
  { path: "account-deleted", element: <AccountDeletedPage /> },
];
