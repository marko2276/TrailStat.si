import { useTranslation } from "react-i18next";

export function StatsPage() {
  const { t } = useTranslation("stats");
  return <h1>{t("title")}</h1>;
}
