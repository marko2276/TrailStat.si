import type { RouteObject } from "react-router";
import { ProfilePage } from "./ProfilePage";

export const routes: RouteObject[] = [{ path: "profile", element: <ProfilePage /> }];
