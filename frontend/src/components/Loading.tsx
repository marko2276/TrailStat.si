import { useTranslation } from "react-i18next";

export function Loading() {
  const { t } = useTranslation();
  return (
    <p className="muted" role="status">
      {t("loading")}
    </p>
  );
}
