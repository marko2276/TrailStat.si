import { useTranslation } from "react-i18next";

export function HikesPage() {
  const { t } = useTranslation("hikes");
  return <h1>{t("title")}</h1>;
}
