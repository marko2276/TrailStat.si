import { useTranslation } from "react-i18next";

export function TrailsPage() {
  const { t } = useTranslation("trails");
  return <h1>{t("title")}</h1>;
}
