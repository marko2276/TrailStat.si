import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { useFormat } from "../../lib/format";
import { useArchiveTrail, useTrail } from "./api";
import type { TrailDetail } from "./api";
import { OsmAttribution } from "./OsmAttribution";
import { ElevationChart } from "./ElevationChart";
import { LazyTrailMap } from "./LazyTrailMap";
import "./trails.css";

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="card">
      <div className="stat-label muted">{label}</div>
      <div className="stat-value">{children}</div>
    </div>
  );
}

function Details({ trail }: { trail: TrailDetail }) {
  const { t } = useTranslation("trails");
  const format = useFormat();
  const archive = useArchiveTrail(trail.id);
  const unknown = t("unknown");
  const elevation = (metres: number | null) =>
    metres === null ? unknown : format.elevation(metres);
  const imported = trail.source === "osm";

  return (
    <>
      <div className="page-header">
        <h1 className="trail-name">{trail.name}</h1>
        {trail.can_edit && (
          <div className="actions">
            <Link className="btn" to={`/trails/${trail.id}/edit`}>
              {t("common:edit")}
            </Link>
            <button
              className="btn"
              disabled={archive.isPending}
              onClick={() => archive.mutate(!trail.archived)}
            >
              {trail.archived ? t("actions.unarchive") : t("actions.archive")}
            </button>
          </div>
        )}
      </div>
      <div className="trail-badges">
        <span className="badge">{t(`visibility.${trail.visibility}`)}</span>
        {trail.group_name && <span className="badge">{trail.group_name}</span>}
        {trail.archived && <span className="badge">{t("archived")}</span>}
      </div>
      {archive.isError && <ErrorMessage error={archive.error} ns="trails" />}
      {trail.archived && <p className="muted">{t("archivedHint")}</p>}

      <div className="stat-grid">
        <Stat label={t("fields.distance")}>{format.distance(trail.distance_m)}</Stat>
        <Stat label={t("fields.gain")}>{elevation(trail.elevation_gain_m)}</Stat>
        <Stat label={t("fields.loss")}>{elevation(trail.elevation_loss_m)}</Stat>
        <Stat label={t("fields.highest")}>{elevation(trail.highest_point_m)}</Stat>
        <Stat label={t("fields.creator")}>{trail.owner_name ?? unknown}</Stat>
      </div>

      {trail.description && <p className="trail-description trail-section">{trail.description}</p>}

      {trail.geometry ? (
        <section className="trail-section">
          <h2>{t("map.title")}</h2>
          <LazyTrailMap geometry={trail.geometry} label={t("map.label", { name: trail.name })} />
        </section>
      ) : (
        <p className="muted trail-section">{t("noMap")}</p>
      )}

      {trail.elevation_profile && trail.elevation_profile.length >= 2 && (
        <section className="trail-section">
          <h2>{t("chart.title")}</h2>
          <ElevationChart profile={trail.elevation_profile} highestPoint={trail.highest_point_m} />
          <p className="attribution muted">{t("copernicusAttribution")}</p>
        </section>
      )}
      {imported && trail.elevation_gain_m === null && (
        <p className="card trail-section" role="note">
          {t("noElevation")}
        </p>
      )}

      {imported && <OsmAttribution relationId={trail.osm_relation_id} />}
    </>
  );
}

export function TrailDetailPage() {
  const { t } = useTranslation("trails");
  const { id } = useParams();
  const { data: trail, error } = useTrail(id!);

  return (
    <>
      <p>
        <Link to="/trails">{t("backToList")}</Link>
      </p>
      {error ? (
        <ErrorMessage error={error} ns="trails" />
      ) : trail ? (
        <Details trail={trail} />
      ) : (
        <Loading />
      )}
    </>
  );
}
