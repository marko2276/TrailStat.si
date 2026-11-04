import { useTranslation } from "react-i18next";
import { useFormat } from "../../lib/format";
import type { Totals } from "./api";

export function StatTiles({ totals }: { totals: Totals }) {
  const { t } = useTranslation("stats");
  const format = useFormat();
  const tiles = [
    { label: t("hikeCount"), value: format.number(totals.hike_count) },
    { label: t("totalDistance"), value: format.distance(totals.total_distance_m) },
    { label: t("totalElevation"), value: format.elevation(totals.total_elevation_gain_m) },
    { label: t("totalDuration"), value: format.duration(totals.total_duration_s) },
    { label: t("averageDuration"), value: format.duration(totals.average_duration_s) },
  ];

  return (
    <dl className="stat-grid" style={{ margin: 0 }}>
      {tiles.map(({ label, value }) => (
        <div className="card" key={label}>
          <dt className="muted">{label}</dt>
          <dd style={{ margin: 0, fontSize: "1.25rem", fontWeight: 600 }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
