import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { useFormat } from "../../lib/format";
import { useTrailSearch } from "./api";
import type { TrailOption } from "./api";

const SEARCH_DELAY_MS = 250;

function useDebounced(value: string): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return debounced;
}

/** Other members must see a group hike's trail too: public, or shared with this group. */
export function isTrailForGroup(trail: TrailOption, groupId: string | null): boolean {
  return groupId === null || trail.visibility === "public" || trail.group_id === groupId;
}

interface Props {
  groupId: string | null;
  onChoose: (trail: TrailOption) => void;
}

export function TrailPicker({ groupId, onChoose }: Props) {
  const { t } = useTranslation("hikes");
  const format = useFormat();
  const [query, setQuery] = useState("");
  const { data, error } = useTrailSearch(useDebounced(query.trim()));
  const trails =
    data?.items.filter((trail) => !trail.archived && isTrailForGroup(trail, groupId)) ?? [];

  return (
    <div className="field">
      <label htmlFor="trail-search">{t("trailSearch")}</label>
      <input
        id="trail-search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        autoComplete="off"
      />
      {error ? <ErrorMessage error={error} ns="hikes" /> : !data && <Loading />}
      {data && trails.length === 0 && <p className="muted">{t("noTrails")}</p>}
      <div className="actions" style={{ flexDirection: "column" }}>
        {trails.map((trail) => (
          <button
            type="button"
            className="btn"
            style={{ textAlign: "left" }}
            key={trail.id}
            onClick={() => onChoose(trail)}
          >
            {trail.name}{" "}
            <span className="muted">
              {[
                format.distance(trail.distance_m),
                ...(trail.elevation_gain_m === null
                  ? []
                  : [format.elevation(trail.elevation_gain_m)]),
              ].join(" · ")}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
