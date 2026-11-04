import type { RouteObject } from "react-router";
import type { NavItem } from "../../app/navigation";
import { HikesPage } from "./HikesPage";
import { EditHikePage, RecordHikePage } from "./RecordHikePage";

export const routes: RouteObject[] = [
  { path: "hikes", element: <HikesPage /> },
  { path: "hikes/new", element: <RecordHikePage /> },
  { path: "hikes/:id/edit", element: <EditHikePage /> },
];

export const navItem: NavItem = { to: "/hikes", label: "hikes:title" };
