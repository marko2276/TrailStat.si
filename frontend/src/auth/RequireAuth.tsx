import { useTranslation } from "react-i18next";
import { Navigate, Outlet, useLocation } from "react-router";
import { Loading } from "../components/Loading";
import { useAuth } from "./AuthContext";

/** Sends anonymous visitors to the login page and returns them afterwards. */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  const { t } = useTranslation();

  if (status === "loading") return <Loading />;
  if (status === "unconfigured") return <p className="error">{t("auth.unconfigured")}</p>;
  if (status === "anonymous") {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}
