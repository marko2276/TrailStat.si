import type { RouteObject } from "react-router";
import { SupportPage } from "./SupportPage";

/** Readable without an account. */
export const publicRoutes: RouteObject[] = [{ path: "support", element: <SupportPage /> }];
