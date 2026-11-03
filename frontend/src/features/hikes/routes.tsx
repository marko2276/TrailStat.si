import type { RouteObject } from "react-router";
import type { NavItem } from "../../app/navigation";
import { HikesPage } from "./HikesPage";

export const routes: RouteObject[] = [{ path: "hikes", element: <HikesPage /> }];

export const navItem: NavItem = { to: "/hikes", label: "hikes:title" };
