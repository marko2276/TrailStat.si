import type { RouteObject } from "react-router";
import type { NavItem } from "../../app/navigation";
import { TrailsPage } from "./TrailsPage";

export const routes: RouteObject[] = [{ path: "trails", element: <TrailsPage /> }];

export const navItem: NavItem = { to: "/trails", label: "trails:title" };
