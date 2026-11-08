import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";
import { useMe } from "../profile/api";

/** Only for the people who run TrailStat.si. */
export function AdminLink() {
  const { t } = useTranslation();
  const me = useMe();
  if (!me.data?.is_admin) return null;
  return <NavLink to="/admin">{t("admin")}</NavLink>;
}
