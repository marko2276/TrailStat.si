import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useDonationDetails } from "./api";

/** Shown only when the server takes donations. */
export function SupportLink() {
  const { t } = useTranslation();
  const details = useDonationDetails();
  if (!details.data) return null;
  return <Link to="/support">{t("support")}</Link>;
}
