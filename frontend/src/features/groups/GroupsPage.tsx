import { useTranslation } from "react-i18next";

export function GroupsPage() {
  const { t } = useTranslation("groups");
  return <h1>{t("title")}</h1>;
}
