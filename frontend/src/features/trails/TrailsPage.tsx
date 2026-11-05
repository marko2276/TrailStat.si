import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { useFormat } from "../../lib/format";
import { PAGE_SIZE, useTrails } from "./api";
import type { Scope, SortField, SortOrder, TrailSummary } from "./api";
import "./trails.css";

const SCOPES: Scope[] = ["all", "public", "mine", "group"];
const SORTS: SortField[] = ["name", "distance", "elevation"];
const ORDERS: SortOrder[] = ["asc", "desc"];
const SEARCH_DELAY_MS = 300;

function oneOf<T extends string>(options: readonly T[], value: string | null, fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

function TrailRow({ trail }: { trail: TrailSummary }) {
  const { t } = useTranslation("trails");
  const format = useFormat();
  return (
    <li className="card">
      <Link className="trail-list-title" to={`/trails/${trail.id}`}>
        {trail.name}
      </Link>
      <div className="trail-list-meta">
        <span>{format.distance(trail.distance_m)}</span>
        <span>
          {trail.elevation_gain_m === null
            ? t("noElevationShort")
            : t("gainValue", { value: format.elevation(trail.elevation_gain_m) })}
        </span>
        <span className="badge">{t(`visibility.${trail.visibility}`)}</span>
        {trail.archived && <span className="badge">{t("archived")}</span>}
      </div>
    </li>
  );
}

/** Filters live in the URL, so that going back from a trail returns to the same list. */
export function TrailsPage() {
  const { t } = useTranslation("trails");
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const scope = oneOf(SCOPES, params.get("scope"), "all");
  const sort = oneOf(SORTS, params.get("sort"), "name");
  const order = oneOf(ORDERS, params.get("order"), "asc");
  const includeArchived = params.get("archived") === "1";
  const offset = Math.max(Number(params.get("offset")) || 0, 0);

  const [searchText, setSearchText] = useState(q);
  const { data, error, isPending } = useTrails({
    q,
    scope,
    includeArchived,
    sort,
    order,
    offset,
  });

  function update(key: string, value: string | null) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (key !== "offset") next.delete("offset");
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  }

  useEffect(() => {
    if (searchText === q) return;
    const timer = setTimeout(() => update("q", searchText || null), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `update` only reads the latest URL
  }, [searchText, q]);

  const filtered = q.trim() !== "" || scope !== "all" || includeArchived;

  return (
    <>
      <div className="page-header">
        <h1>{t("title")}</h1>
        <div className="actions">
          <Link className="btn btn-primary" to="/trails/import">
            {t("actions.import")}
          </Link>
          <Link className="btn" to="/trails/new">
            {t("actions.create")}
          </Link>
        </div>
      </div>

      <div className="trail-filters">
        <div className="field field-wide">
          <label htmlFor="trail-search">{t("list.search")}</label>
          <input
            id="trail-search"
            type="search"
            value={searchText}
            maxLength={200}
            onChange={(event) => setSearchText(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="trail-scope">{t("list.filter")}</label>
          <select
            id="trail-scope"
            value={scope}
            onChange={(event) =>
              update("scope", event.target.value === "all" ? null : event.target.value)
            }
          >
            {SCOPES.map((option) => (
              <option key={option} value={option}>
                {t(`scope.${option}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="trail-sort">{t("list.sort")}</label>
          <select
            id="trail-sort"
            value={sort}
            onChange={(event) =>
              update("sort", event.target.value === "name" ? null : event.target.value)
            }
          >
            {SORTS.map((option) => (
              <option key={option} value={option}>
                {t(`sort.${option}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="trail-order">{t("list.order")}</label>
          <select
            id="trail-order"
            value={order}
            onChange={(event) =>
              update("order", event.target.value === "asc" ? null : event.target.value)
            }
          >
            {ORDERS.map((option) => (
              <option key={option} value={option}>
                {t(`order.${option}`)}
              </option>
            ))}
          </select>
        </div>
        <label className="check-field">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => update("archived", event.target.checked ? "1" : null)}
          />
          {t("list.showArchived")}
        </label>
      </div>

      {error && <ErrorMessage error={error} ns="trails" />}
      {isPending && <Loading />}
      {data && !error && data.items.length === 0 && (
        <p className="muted">{filtered ? t("list.noMatches") : t("list.empty")}</p>
      )}
      {data && !error && data.items.length > 0 && (
        <>
          <ul className="trail-list">
            {data.items.map((trail) => (
              <TrailRow key={trail.id} trail={trail} />
            ))}
          </ul>
          {data.total > PAGE_SIZE && (
            <div className="pagination">
              <button
                className="btn"
                disabled={offset === 0}
                onClick={() => update("offset", String(Math.max(offset - PAGE_SIZE, 0)))}
              >
                {t("common:previous")}
              </button>
              <span className="muted">
                {t("list.range", {
                  from: data.offset + 1,
                  to: data.offset + data.items.length,
                  total: data.total,
                })}
              </span>
              <button
                className="btn"
                disabled={offset + PAGE_SIZE >= data.total}
                onClick={() => update("offset", String(offset + PAGE_SIZE))}
              >
                {t("common:next")}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
