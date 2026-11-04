import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { accountDeletion, useAuth } from "../../auth/AuthContext";
import { deleteHankoAccount } from "../../auth/hanko";
import { ErrorMessage } from "../../components/ErrorMessage";
import { api } from "../../lib/api";
import type { Me } from "./api";

function downloadJson(data: unknown, filename: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function AccountData({ me }: { me: Me }) {
  const { t } = useTranslation("profile");
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [typedEmail, setTypedEmail] = useState("");

  const exportData = useMutation({
    mutationFn: () => api.get<unknown>("/me/export"),
    onSuccess: (data) => downloadJson(data, "trailstat-export.json"),
  });

  const deleteAccount = useMutation({
    mutationFn: async () => {
      accountDeletion.inProgress = true;
      try {
        // Ours first: the session is needed for this, and deleting at Hanko ends it.
        await api.delete("/me");
        const loginDeleted = await deleteHankoAccount();
        await logout().catch(() => undefined);
        return loginDeleted;
      } finally {
        accountDeletion.inProgress = false;
      }
    },
    onSuccess: (loginDeleted) =>
      void navigate(loginDeleted ? "/account-deleted" : "/account-deleted?login=kept", {
        replace: true,
      }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    deleteAccount.mutate();
  }

  return (
    <>
      <h2>{t("data.title")}</h2>
      <div className="card form">
        <p>
          {t("data.exportHint")} <Link to="/privacy">{t("common:privacy")}</Link>
        </p>
        <div>
          <button
            className="btn"
            onClick={() => exportData.mutate()}
            disabled={exportData.isPending}
          >
            {t("data.export")}
          </button>
        </div>
        {exportData.isError && <ErrorMessage error={exportData.error} ns="profile" />}

        {!confirming ? (
          <div>
            <button className="btn btn-danger" onClick={() => setConfirming(true)}>
              {t("data.delete")}
            </button>
          </div>
        ) : (
          <form className="form" onSubmit={submit}>
            <p>{t("data.deleteIntro")}</p>
            <ul>
              <li>{t("data.deleteProfile")}</li>
              <li>{t("data.deleteHikes")}</li>
              <li>{t("data.deleteTrails")}</li>
              <li>{t("data.deleteGroups")}</li>
            </ul>
            <div className="field">
              <label htmlFor="confirm-email">{t("data.confirmLabel", { email: me.email })}</label>
              <input
                id="confirm-email"
                type="email"
                autoComplete="off"
                value={typedEmail}
                onChange={(event) => setTypedEmail(event.target.value)}
              />
            </div>
            {deleteAccount.isError && <ErrorMessage error={deleteAccount.error} ns="profile" />}
            <div className="actions">
              <button
                className="btn btn-danger"
                disabled={
                  deleteAccount.isPending ||
                  typedEmail.trim().toLowerCase() !== me.email.toLowerCase()
                }
              >
                {t("data.deleteConfirm")}
              </button>
              <button type="button" className="btn" onClick={() => setConfirming(false)}>
                {t("common:cancel")}
              </button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
