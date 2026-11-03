import { useTranslation } from "react-i18next";
import { useMe } from "../features/profile/api";

export function HomePage() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  return <h1>{me ? t("home.welcome", { name: me.display_name }) : t("appName")}</h1>;
}
