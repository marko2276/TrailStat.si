import { useTranslation } from "react-i18next";
import type { RouteObject } from "react-router";
import { LoginPage } from "../auth/LoginPage";
import { RequireAuth } from "../auth/RequireAuth";
import * as groups from "../features/groups/routes";
import * as hikes from "../features/hikes/routes";
import * as profile from "../features/profile/routes";
import * as stats from "../features/stats/routes";
import * as support from "../features/support/routes";
import * as trails from "../features/trails/routes";
import { HomePage } from "./HomePage";
import { Layout } from "./Layout";
import type { NavItem } from "./navigation";

export const navItems: NavItem[] = [trails.navItem, hikes.navItem, groups.navItem, stats.navItem];

function NotFound() {
  const { t } = useTranslation();
  return <p>{t("notFound")}</p>;
}

export const appRoutes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { path: "login", element: <LoginPage /> },
      ...profile.publicRoutes,
      ...support.publicRoutes,
      {
        element: <RequireAuth />,
        children: [
          { index: true, element: <HomePage /> },
          ...profile.routes,
          ...trails.routes,
          ...hikes.routes,
          ...groups.routes,
          ...stats.routes,
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
];
