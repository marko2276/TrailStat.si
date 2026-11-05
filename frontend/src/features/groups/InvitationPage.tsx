import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { useAuth } from "../../auth/AuthContext";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { useFormat } from "../../lib/format";
import { useMe } from "../profile/api";
import { useAcceptInvitation, useDeclineInvitation, useInvitationView } from "./api";
import type { InvitationView } from "./api";

function CannotAccept({ reason }: { reason: "wrongAccount" | "verifyFirst" }) {
  const { t } = useTranslation("groups");
  const { logout } = useAuth();
  const { data: me } = useMe();

  return (
    <>
      <p role="alert">{t(`invitation.${reason}`)}</p>
      {me && (
        <p className="muted wrap-anywhere">{t("invitation.signedInAs", { email: me.email })}</p>
      )}
      <div>
        {/* Signing out leads to the login page, and from there back to this link. */}
        <button type="button" className="btn btn-primary" onClick={() => void logout()}>
          {t("invitation.switchAccount")}
        </button>
      </div>
    </>
  );
}

function Decision({
  token,
  invitation,
  onDeclined,
}: {
  token: string;
  invitation: InvitationView;
  onDeclined: () => void;
}) {
  const { t } = useTranslation("groups");
  const format = useFormat();
  const navigate = useNavigate();
  const accept = useAcceptInvitation(token);
  const decline = useDeclineInvitation(token);
  const busy = accept.isPending || decline.isPending;
  const error = accept.error ?? decline.error;

  return (
    <>
      <p>
        {invitation.inviter_name
          ? t("invitation.fromInviter", {
              inviter: invitation.inviter_name,
              group: invitation.group_name,
            })
          : t("invitation.toGroup", { group: invitation.group_name })}
      </p>
      <p className="muted">
        {t("invitation.validUntil", { date: format.date(invitation.expires_at) })}
      </p>
      {error && <ErrorMessage error={error} ns="groups" />}
      <div className="actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            accept.mutate(undefined, {
              onSuccess: (group) => void navigate(`/groups/${group.id}`, { replace: true }),
            })
          }
        >
          {t("invitation.accept")}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => decline.mutate(undefined, { onSuccess: onDeclined })}
        >
          {t("invitation.decline")}
        </button>
      </div>
    </>
  );
}

export function InvitationPage() {
  const { t } = useTranslation("groups");
  const { token = "" } = useParams();
  const [declined, setDeclined] = useState(false);
  const { data, error } = useInvitationView(token, !declined);

  return (
    <div className="card form">
      <h1>{t("invitation.title")}</h1>
      {declined && <p role="status">{t("invitation.declined")}</p>}
      {!declined && error && <ErrorMessage error={error} ns="groups" />}
      {!declined && !error && !data && <Loading />}
      {!declined &&
        !error &&
        data &&
        (data.email_matches ? (
          <Decision token={token} invitation={data} onDeclined={() => setDeclined(true)} />
        ) : (
          <CannotAccept reason={data.email_verified ? "wrongAccount" : "verifyFirst"} />
        ))}
      {(declined || error) && (
        <p>
          <Link to="/groups">{t("backToGroups")}</Link>
        </p>
      )}
    </div>
  );
}
