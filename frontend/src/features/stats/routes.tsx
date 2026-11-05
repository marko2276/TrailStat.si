import type { RouteObject } from "react-router";
import type { NavItem } from "../../app/navigation";
import { StatsPage } from "./StatsPage";

export const routes: RouteObject[] = [{ path: "stats", element: <StatsPage /> }];

export const navItem: NavItem = { to: "/stats", label: "stats:title" };
