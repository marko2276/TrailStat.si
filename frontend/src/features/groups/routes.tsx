import type { RouteObject } from "react-router";
import type { NavItem } from "../../app/navigation";
import { GroupsPage } from "./GroupsPage";

export const routes: RouteObject[] = [{ path: "groups", element: <GroupsPage /> }];

export const navItem: NavItem = { to: "/groups", label: "groups:title" };
