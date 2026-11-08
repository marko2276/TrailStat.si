import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { useFormat } from "../../lib/format";
import { useGroup, useMyGroups } from "../hikes/api";
import { toDateInput } from "../hikes/localTime";
import { PagedHikes } from "../hikes/PagedHikes";
import { useGroupStats, useGroupSummary, useMyStats } from "./api";
import { BestTimes } from "./BestTimes";
import type { AttendeeTotals } from "./api";
import { periodRange } from "./period";
import type { Period, PeriodRange } from "./period";
import { PeriodPicker } from "./PeriodPicker";
import { StatTiles } from "./StatTiles";

function PersonalStats({ range }: { range: PeriodRange }) {
  const { t } = useTranslation("stats");
  const { data, error } = useMyStats(range);

  if (error) return <ErrorMessage error={error} ns="stats" />;
  if (!data) return <Loading />;
  return (
    <>
      <StatTiles totals={data} />
      <BestTimes groupId={null} range={range} />
      <h2>{t("hikes")}</h2>
      <PagedHikes
        key={JSON.stringify(range)}
        groupId={null}
        period={range}
        emptyText={t("empty")}
      />
    </>
  );
}

function Breakdown({ attendees }: { attendees: AttendeeTotals[] }) {
  const { t } = useTranslation("stats");
  const format = useFormat();

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">{t("attendee")}</th>
            <th scope="col">{t("columns.hikes")}</th>
            <th scope="col">{t("columns.distance")}</th>
            <th scope="col">{t("columns.elevation")}</th>
            <th scope="col">{t("columns.duration")}</th>
            <th scope="col">{t("columns.average")}</th>
          </tr>
        </thead>
        <tbody>
          {attendees.map(({ user_id, guest_id, name, totals }) => (
            <tr key={user_id ?? guest_id}>
              <th scope="row" style={{ fontWeight: 400 }}>
                {name} {guest_id && <span className="badge">{t("guest")}</span>}
              </th>
              <td>{format.number(totals.hike_count)}</td>
              <td>{format.distance(totals.total_distance_m)}</td>
              <td>{format.elevation(totals.total_elevation_gain_m)}</td>
              <td>{format.duration(totals.total_duration_s)}</td>
              <td>{format.duration(totals.average_duration_s)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MemberGroupStats({ groupId, range }: { groupId: string; range: PeriodRange }) {
  const { t } = useTranslation("stats");
  const { data, error } = useGroupStats(groupId, range);

  if (error) return <ErrorMessage error={error} ns="stats" />;
  if (!data) return <Loading />;
  return (
    <>
      <StatTiles totals={data.totals} />
      <h2>{t("breakdown")}</h2>
      {data.attendees.length > 0 ? (
        <Breakdown attendees={data.attendees} />
      ) : (
        <p className="muted">{t("empty")}</p>
      )}
      <BestTimes groupId={groupId} range={range} />
      <h2>{t("hikes")}</h2>
      <PagedHikes
        key={`${groupId}${JSON.stringify(range)}`}
        groupId={groupId}
        period={range}
        emptyText={t("empty")}
      />
    </>
  );
}

/** What anyone may see of a public group: totals only, for all time. */
function PublicGroupSummary({ groupId }: { groupId: string }) {
  const { t } = useTranslation("stats");
  const { data, error } = useGroupSummary(groupId);

  if (error) return <ErrorMessage error={error} ns="stats" />;
  if (!data) return <Loading />;
  return (
    <>
      <p className="muted">{t("summaryOnly")}</p>
      <StatTiles totals={data} />
    </>
  );
}

function SubjectPicker({ groupId }: { groupId: string | null }) {
  const { t } = useTranslation("stats");
  const [, setParams] = useSearchParams();
  const { data, error } = useMyGroups();
  const group = useGroup(groupId);
  const groups = data?.items ?? [];
  const outside = groupId && !groups.some((mine) => mine.id === groupId);

  return (
    <div className="field">
      <label htmlFor="stats-subject">{t("subject")}</label>
      <select
        id="stats-subject"
        value={groupId ?? ""}
        onChange={(event) =>
          void setParams(event.target.value ? { group: event.target.value } : {})
        }
      >
        <option value="">{t("me")}</option>
        {outside && <option value={groupId}>{group.data?.name ?? t("group")}</option>}
        {groups.map((mine) => (
          <option key={mine.id} value={mine.id}>
            {mine.name}
          </option>
        ))}
      </select>
      {error && <ErrorMessage error={error} ns="stats" />}
    </div>
  );
}

interface GroupViewProps {
  groupId: string;
  period: Period;
  onPeriodChange: (period: Period) => void;
}

function GroupStatsView({ groupId, period, onPeriodChange }: GroupViewProps) {
  const { data: group, error } = useGroup(groupId);

  if (error) return <ErrorMessage error={error} ns="stats" />;
  if (!group) return <Loading />;
  if (!group.is_member) return <PublicGroupSummary groupId={groupId} />;
  return (
    <>
      <PeriodPicker period={period} onChange={onPeriodChange} />
      <div style={{ marginTop: "1rem" }}>
        <MemberGroupStats groupId={groupId} range={periodRange(period)} />
      </div>
    </>
  );
}

export function StatsPage() {
  const { t } = useTranslation("stats");
  const [params] = useSearchParams();
  const groupId = params.get("group");
  const [period, setPeriod] = useState<Period>(() => ({
    kind: "all",
    date: toDateInput(new Date()),
  }));

  return (
    <>
      <h1>{t("title")}</h1>
      <div className="form" style={{ marginBottom: "1rem" }}>
        <SubjectPicker groupId={groupId} />
      </div>
      {groupId ? (
        <GroupStatsView groupId={groupId} period={period} onPeriodChange={setPeriod} />
      ) : (
        <>
          <PeriodPicker period={period} onChange={setPeriod} />
          <div style={{ marginTop: "1rem" }}>
            <PersonalStats range={periodRange(period)} />
          </div>
        </>
      )}
    </>
  );
}
