import type { RouteObject } from "react-router";
import type { NavItem } from "../../app/navigation";
import { OsmImportPage } from "./OsmImportPage";
import { TrailDetailPage } from "./TrailDetailPage";
import { EditTrailPage, NewTrailPage } from "./TrailFormPages";
import { TrailsPage } from "./TrailsPage";

export const routes: RouteObject[] = [
  { path: "trails", element: <TrailsPage /> },
  { path: "trails/new", element: <NewTrailPage /> },
  { path: "trails/import", element: <OsmImportPage /> },
  { path: "trails/:id", element: <TrailDetailPage /> },
  { path: "trails/:id/edit", element: <EditTrailPage /> },
];

export const navItem: NavItem = { to: "/trails", label: "trails:title" };
