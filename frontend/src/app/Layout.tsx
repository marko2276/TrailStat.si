import { useTranslation } from "react-i18next";
import { Link, NavLink, Outlet } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { AdminLink } from "../features/admin/AdminLink";
import { LanguageSwitcher } from "../features/profile/LanguageSwitcher";
import { LanguageSync } from "../features/profile/LanguageSync";
import { SupportLink } from "../features/support/SupportLink";
import { navItems } from "./routes";

export function Layout() {
  const { t } = useTranslation();
  const { status, logout } = useAuth();
  const signedIn = status === "authenticated";

  return (
    <>
      {signedIn && <LanguageSync />}
      <header className="site-header">
        <Link to="/" className="brand">
          {t("appName")}
        </Link>
        {signedIn && (
          <nav aria-label={t("mainNavigation")}>
            {navItems.map((item) => (
              <NavLink key={item.to} to={item.to}>
                {t(item.label)}
              </NavLink>
            ))}
          </nav>
        )}
        <div className="site-header-actions">
          <LanguageSwitcher />
          {signedIn && (
            <>
              <AdminLink />
              <NavLink to="/profile">{t("profile")}</NavLink>
              <button className="btn" onClick={() => void logout()}>
                {t("logout")}
              </button>
            </>
          )}
        </div>
      </header>
      <main className="site-main">
        <Outlet />
      </main>
      <footer className="site-footer">
        <Link to="/privacy">{t("privacy")}</Link>
        <SupportLink />
      </footer>
    </>
  );
}
