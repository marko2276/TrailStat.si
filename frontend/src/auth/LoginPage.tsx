import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation } from "react-router";
import { Loading } from "../components/Loading";
import { useAuth } from "./AuthContext";
import { getHanko } from "./hanko";

export function LoginPage() {
  const { status } = useAuth();
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (status !== "anonymous") return;
    let active = true;
    void getHanko().then(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, [status]);

  if (status === "authenticated") {
    const from = (location.state as { from?: string } | null)?.from ?? "/";
    return <Navigate to={from} replace />;
  }
  if (status === "unconfigured") return <p className="error">{t("auth.unconfigured")}</p>;
  if (status === "loading" || !ready) return <Loading />;

  return (
    <div className="auth-box">
      <h1>{t("appName")}</h1>
      <p className="muted">{t("auth.tagline")}</p>
      <hanko-auth lang={i18n.resolvedLanguage} />
    </div>
  );
}
