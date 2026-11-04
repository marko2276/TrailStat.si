import { useTranslation } from "react-i18next";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { useFormat } from "../../lib/format";
import { useCancelJoinRequest, useGroupSummary, useMyJoinRequest, useRequestToJoin } from "./api";
import type { Group } from "./api";

function SummaryTotals({ groupId }: { groupId: string }) {
  const { t } = useTranslation("groups");
  const format = useFormat();
  const { data, error, isPending } = useGroupSummary(groupId);

  // The totals are a bonus on this page: without them the rest must still work.
  if (error) return <p className="muted">{t("summary.unavailable")}</p>;
  if (isPending) return <Loading />;

  const totals = [
    { label: t("summary.hikes"), value: format.number(data.hike_count) },
    { label: t("summary.distance"), value: format.distance(data.total_distance_m) },
    { label: t("summary.elevation"), value: format.elevation(data.total_elevation_gain_m) },
    { label: t("summary.duration"), value: format.duration(data.total_duration_s) },
  ];
  return (
    <dl className="stat-grid">
      {totals.map(({ label, value }) => (
        <div key={label} className="card">
          <dt className="muted">{label}</dt>
          <dd className="stat-value">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function JoinPanel({ groupId }: { groupId: string }) {
  const { t } = useTranslation("groups");
  const { data, error } = useMyJoinRequest(groupId);
  const join = useRequestToJoin(groupId);
  const cancel = useCancelJoinRequest(groupId);

  if (error) return <ErrorMessage error={error} ns="groups" />;
  if (!data) return <Loading />;

  const mutationError = join.error ?? cancel.error;
  return (
    <div className="card form">
      {data.status === "pending" ? (
        <>
          <p role="status">{t("join.pending")}</p>
          <div>
            <button
              type="button"
              className="btn"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(undefined)}
            >
              {t("join.cancel")}
            </button>
          </div>
        </>
      ) : (
        <>
          {data.status === "rejected" && <p role="status">{t("join.rejected")}</p>}
          <div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={join.isPending}
              onClick={() => join.mutate(undefined)}
            >
              {data.status === "rejected" ? t("join.again") : t("join.request")}
            </button>
          </div>
        </>
      )}
      {mutationError && <ErrorMessage error={mutationError} ns="groups" />}
    </div>
  );
}

/** A public group seen from outside: only its name, its totals and the way in. */
export function NonMemberView({ group }: { group: Group }) {
  const { t } = useTranslation("groups");
  return (
    <>
      <h1>{group.name}</h1>
      <h2>{t("summary.title")}</h2>
      <SummaryTotals groupId={group.id} />
      <h2>{t("join.title")}</h2>
      <JoinPanel groupId={group.id} />
    </>
  );
}
