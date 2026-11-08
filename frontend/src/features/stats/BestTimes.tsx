import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { useFormat } from "../../lib/format";
import { useBestTimes } from "./api";
import type { PeriodRange } from "./period";

/** Per trail hiked in the period: how often, and the fastest time. Nothing without hikes. */
export function BestTimes({ groupId, range }: { groupId: string | null; range: PeriodRange }) {
  const { t } = useTranslation("stats");
  const format = useFormat();
  const { data, error } = useBestTimes(groupId, range);

  if (error) return <ErrorMessage error={error} ns="stats" />;
  if (!data) return <Loading />;
  if (data.length === 0) return null;
  return (
    <section>
      <h2>{t("bestTimes.title")}</h2>
      <p className="muted">{groupId ? t("bestTimes.hintGroup") : t("bestTimes.hint")}</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">{t("bestTimes.trail")}</th>
              <th scope="col">{t("columns.distance")}</th>
              <th scope="col">{t("columns.hikes")}</th>
              <th scope="col">{t("bestTimes.best")}</th>
              <th scope="col">{t("bestTimes.date")}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.trail.id}>
                <th scope="row" style={{ fontWeight: 400 }}>
                  <Link to={`/trails/${row.trail.id}`}>{row.trail.name}</Link>
                </th>
                <td>{format.distance(row.trail.distance_m)}</td>
                <td>{format.number(row.hike_count)}</td>
                <td>{format.duration(row.best_duration_s)}</td>
                <td>{format.date(row.best_start_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
