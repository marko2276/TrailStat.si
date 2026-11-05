import { useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { useFormat } from "../../lib/format";
import { ConfirmAction } from "./ConfirmAction";
import { useInvitations, useInvite, useResendInvitation, useRevokeInvitation } from "./api";
import type { Invitation } from "./api";

function InvitationRow({ groupId, invitation }: { groupId: string; invitation: Invitation }) {
  const { t } = useTranslation("groups");
  const format = useFormat();
  const resend = useResendInvitation(groupId);
  const revoke = useRevokeInvitation(groupId);
  const error = resend.error ?? revoke.error;

  return (
    <li className="card">
      <div className="wrap-anywhere">{invitation.email}</div>
      <div className="muted">
        {invitation.expired
          ? t("invitations.expired")
          : t("invitations.expires", { date: format.date(invitation.expires_at) })}
      </div>
      <div className="actions row-actions">
        <button
          type="button"
          className="btn"
          disabled={resend.isPending}
          onClick={() => resend.mutate(invitation.id)}
        >
          {t("invitations.resend")}
        </button>
        <ConfirmAction
          label={t("invitations.revoke")}
          confirmLabel={t("invitations.revokeConfirm")}
          pending={revoke.isPending}
          onConfirm={() => revoke.mutate(invitation.id)}
        >
          <p>{t("invitations.revokeWarning")}</p>
        </ConfirmAction>
      </div>
      {resend.isSuccess && <p role="status">{t("invitations.resent")}</p>}
      {error && <ErrorMessage error={error} ns="groups" />}
    </li>
  );
}

export function InvitationsSection({ groupId }: { groupId: string }) {
  const { t } = useTranslation("groups");
  const { data, error } = useInvitations(groupId);
  const invite = useInvite(groupId);
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    setSentTo(null);
    invite.mutate(email, {
      onSuccess: (invitation) => {
        setSentTo(invitation.email);
        setEmail("");
      },
    });
  }

  return (
    <section aria-labelledby="group-invitations">
      <h2 id="group-invitations">{t("invitations.title")}</h2>
      <form className="form card" onSubmit={submit}>
        <div className="field">
          <label htmlFor="invite-email">{t("invitations.email")}</label>
          <input
            id="invite-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            maxLength={320}
          />
        </div>
        {invite.isError && <ErrorMessage error={invite.error} ns="groups" />}
        {sentTo && <p role="status">{t("invitations.sent", { email: sentTo })}</p>}
        <div>
          <button className="btn btn-primary" disabled={invite.isPending}>
            {t("invitations.send")}
          </button>
        </div>
      </form>
      <h3>{t("invitations.pending")}</h3>
      {error && <ErrorMessage error={error} ns="groups" />}
      {!error && !data && <Loading />}
      {data && data.items.length === 0 && <p className="muted">{t("invitations.none")}</p>}
      {data && data.items.length > 0 && (
        <ul className="plain-list">
          {data.items.map((invitation) => (
            <InvitationRow key={invitation.id} groupId={groupId} invitation={invitation} />
          ))}
        </ul>
      )}
    </section>
  );
}
