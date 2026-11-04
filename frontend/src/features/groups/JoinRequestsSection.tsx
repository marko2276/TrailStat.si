import { useTranslation } from "react-i18next";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { useFormat } from "../../lib/format";
import { useDecideJoinRequest, useJoinRequests } from "./api";
import type { JoinRequest } from "./api";

function RequestRow({ groupId, request }: { groupId: string; request: JoinRequest }) {
  const { t } = useTranslation("groups");
  const format = useFormat();
  const decide = useDecideJoinRequest(groupId);

  return (
    <li className="card">
      <div>{request.display_name}</div>
      <div className="muted">{format.date(request.created_at)}</div>
      <div className="actions row-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={decide.isPending}
          onClick={() => decide.mutate({ requestId: request.id, decision: "approve" })}
        >
          {t("requests.approve")}
        </button>
        <button
          type="button"
          className="btn"
          disabled={decide.isPending}
          onClick={() => decide.mutate({ requestId: request.id, decision: "reject" })}
        >
          {t("requests.reject")}
        </button>
      </div>
      {decide.isError && <ErrorMessage error={decide.error} ns="groups" />}
    </li>
  );
}

export function JoinRequestsSection({ groupId }: { groupId: string }) {
  const { t } = useTranslation("groups");
  const { data, error } = useJoinRequests(groupId);

  return (
    <section aria-labelledby="group-requests">
      <h2 id="group-requests">{t("requests.title")}</h2>
      {error && <ErrorMessage error={error} ns="groups" />}
      {!error && !data && <Loading />}
      {data && data.items.length === 0 && <p className="muted">{t("requests.none")}</p>}
      {data && data.items.length > 0 && (
        <ul className="plain-list">
          {data.items.map((request) => (
            <RequestRow key={request.id} groupId={groupId} request={request} />
          ))}
        </ul>
      )}
    </section>
  );
}
