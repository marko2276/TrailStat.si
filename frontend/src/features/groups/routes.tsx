import type { RouteObject } from "react-router";
import type { NavItem } from "../../app/navigation";
import { GroupCreatePage } from "./GroupCreatePage";
import { GroupDetailPage } from "./GroupDetailPage";
import { GroupsPage } from "./GroupsPage";
import { InvitationPage } from "./InvitationPage";

export const routes: RouteObject[] = [
  { path: "groups", element: <GroupsPage /> },
  { path: "groups/new", element: <GroupCreatePage /> },
  { path: "groups/:id", element: <GroupDetailPage /> },
  // Behind sign-in like the others: someone new signs up and returns to this link.
  { path: "invitations/:token", element: <InvitationPage /> },
];

export const navItem: NavItem = { to: "/groups", label: "groups:title" };
