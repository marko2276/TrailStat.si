import type { RouteObject } from "react-router";
import { AdminPage } from "./AdminPage";

export const routes: RouteObject[] = [{ path: "admin", element: <AdminPage /> }];
