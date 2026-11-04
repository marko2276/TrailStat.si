import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ErrorMessage } from "../../components/ErrorMessage";
import { useFormat } from "../../lib/format";
import { useDeleteHike } from "./api";
import type { Hike } from "./api";

/**
 * A hike without a group that still has other attendees, or that the user can't edit, was
 * a group hike whose group is gone. Deleting it takes it from this user's history only.
 */
function removesOnlyOwnAttendance(hike: Hike): boolean {
  return hike.group_id === null && (hike.attendees.length > 1 || !hike.can_edit);
}

function DeleteControl({ hike }: { hike: Hike }) {
  const { t } = useTranslation("hikes");
  const deleteHike = useDeleteHike(hike.id);
  const [confirming, setConfirming] = useState(false);
  const ownOnly = removesOnlyOwnAttendance(hike);

  if (!confirming) {
    return (
      <button className="btn btn-danger" onClick={() => setConfirming(true)}>
        {ownOnly ? t("removeFromHistory") : t("common:delete")}
      </button>
    );
  }
  return (
    <div className="card" role="group" aria-label={t("deleteConfirmLabel")}>
      <p>{ownOnly ? t("deleteOwnConfirm") : t("deleteConfirm")}</p>
      {deleteHike.isError && <ErrorMessage error={deleteHike.error} ns="hikes" />}
      <div className="actions">
        <button
          className="btn btn-danger"
          disabled={deleteHike.isPending}
          onClick={() => deleteHike.mutate()}
        >
          {t("common:confirm")}
        </button>
        <button className="btn" onClick={() => setConfirming(false)}>
          {t("common:cancel")}
        </button>
      </div>
    </div>
  );
}

export function HikeCard({ hike }: { hike: Hike }) {
  const { t } = useTranslation("hikes");
  const format = useFormat();
  const { trail } = hike;
  const details = [
    format.dateTime(hike.start_at),
    format.duration(hike.duration_s),
    format.distance(trail.distance_m),
    ...(trail.elevation_gain_m === null ? [] : [format.elevation(trail.elevation_gain_m)]),
  ];

  return (
    <article className="card">
      <h3 style={{ margin: 0 }}>{trail.name}</h3>
      <p className="muted" style={{ margin: 0 }}>
        {details.join(" · ")}
      </p>
      <p style={{ margin: "0.25rem 0" }}>
        {hike.group_name && <span className="badge">{hike.group_name}</span>}{" "}
        {trail.archived && <span className="badge">{t("archived")}</span>}
      </p>
      {hike.attendees.length > 0 && (hike.group_id !== null || hike.attendees.length > 1) && (
        <p style={{ margin: "0.25rem 0" }}>
          {t("attendedBy", { names: hike.attendees.map((attendee) => attendee.name).join(", ") })}
        </p>
      )}
      {hike.notes && <p style={{ margin: "0.25rem 0", whiteSpace: "pre-wrap" }}>{hike.notes}</p>}
      {(hike.can_edit || hike.can_delete) && (
        <div className="actions" style={{ marginTop: "0.5rem" }}>
          {hike.can_edit && (
            <Link className="btn" to={`/hikes/${hike.id}/edit`}>
              {t("common:edit")}
            </Link>
          )}
          {hike.can_delete && <DeleteControl hike={hike} />}
        </div>
      )}
    </article>
  );
}

export function HikeList({ hikes }: { hikes: Hike[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {hikes.map((hike) => (
        <HikeCard key={hike.id} hike={hike} />
      ))}
    </div>
  );
}
