import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { accountDeletion } from "../../auth/AuthContext";

export function AccountDeletedPage() {
  const { t } = useTranslation("profile");
  const [params] = useSearchParams();

  useEffect(() => {
    accountDeletion.inProgress = false;
  }, []);

  return (
    <>
      <h1>{t("deleted.title")}</h1>
      <p>{t("deleted.done")}</p>
      {params.get("login") === "kept" && <p>{t("deleted.loginKept")}</p>}
    </>
  );
}
