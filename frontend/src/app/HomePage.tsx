import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ErrorMessage } from "../components/ErrorMessage";
import { Loading } from "../components/Loading";
import { useHikes } from "../features/hikes/api";
import { HikeList } from "../features/hikes/HikeCard";
import { DEFAULT_DISPLAY_NAME, useMe } from "../features/profile/api";
import { useMyStats } from "../features/stats/api";
import { periodRange } from "../features/stats/period";
import { StatTiles } from "../features/stats/StatTiles";
import { toDateInput } from "../features/hikes/localTime";

const RECENT_HIKES = 5;

function ThisYear() {
  const { t } = useTranslation("stats");
  const [range] = useState(() => periodRange({ kind: "year", date: toDateInput(new Date()) }));
  const { data, error } = useMyStats(range);

  return (
    <>
      <h2>{t("thisYear")}</h2>
      {error ? (
        <ErrorMessage error={error} ns="stats" />
      ) : data ? (
        <StatTiles totals={data} />
      ) : (
        <Loading />
      )}
    </>
  );
}

function RecentHikes() {
  const { t } = useTranslation("hikes");
  const { data, error } = useHikes(null, { limit: RECENT_HIKES });

  return (
    <>
      <h2>{t("recent")}</h2>
      {error ? (
        <ErrorMessage error={error} ns="hikes" />
      ) : !data ? (
        <Loading />
      ) : data.items.length === 0 ? (
        <p className="muted">{t("emptyMine")}</p>
      ) : (
        <>
          <HikeList hikes={data.items} />
          <p>
            <Link to="/hikes">{t("allHikes")}</Link>
          </p>
        </>
      )}
    </>
  );
}

export function HomePage() {
  const { t } = useTranslation();
  const { data: me } = useMe();

  return (
    <>
      <div className="page-header">
        <h1>{me ? t("home.welcome", { name: me.display_name }) : t("appName")}</h1>
        <Link className="btn btn-primary" to="/hikes/new">
          {t("hikes:record")}
        </Link>
      </div>
      {me?.display_name === DEFAULT_DISPLAY_NAME && (
        <p>
          <Link to="/profile">{t("home.defaultNamePrompt", { name: me.display_name })}</Link>
        </p>
      )}
      <ThisYear />
      <RecentHikes />
    </>
  );
}
