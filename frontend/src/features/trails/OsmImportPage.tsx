import { useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { useFormat } from "../../lib/format";
import { useImportOsmRoute, useOsmPreview, useOsmSearch } from "./api";
import type { OsmPreview, OsmRoute } from "./api";
import { LazyTrailMap } from "./LazyTrailMap";
import { OsmAttribution } from "./OsmAttribution";
import { DEFAULT_SHARING, toSharing, VisibilityFields } from "./VisibilityFields";
import "./trails.css";

const MIN_SEARCH_LENGTH = 2;

function ImportForm({ preview }: { preview: OsmPreview }) {
  const { t } = useTranslation("trails");
  const format = useFormat();
  const navigate = useNavigate();
  const importRoute = useImportOsmRoute();
  const [name, setName] = useState(preview.name ?? "");
  const [sharing, setSharing] = useState(DEFAULT_SHARING);
  const [invalid, setInvalid] = useState<{ name?: string; group?: string }>({});

  function submit(event: FormEvent) {
    event.preventDefault();
    const found = {
      name: name.trim() ? undefined : t("validation.name"),
      group: sharing.visibility === "group" && !sharing.groupId ? t("validation.group") : undefined,
    };
    setInvalid(found);
    if (found.name || found.group) return;
    importRoute.mutate(
      { relation_id: preview.relation_id, name: name.trim(), ...toSharing(sharing) },
      { onSuccess: (trail) => void navigate(`/trails/${trail.id}`) },
    );
  }

  return (
    <form className="form card trail-section" onSubmit={submit} noValidate>
      <p>{t("osm.previewDistance", { distance: format.distance(preview.distance_m) })}</p>
      {!preview.complete && (
        <p role="note">
          {t("osm.incomplete", {
            used: format.distance(preview.distance_m),
            total: format.distance(preview.member_length_m),
          })}
        </p>
      )}
      <div className="field">
        <label htmlFor="trail-name">{t("fields.name")}</label>
        <input
          id="trail-name"
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={invalid.name ? true : undefined}
        />
        {invalid.name && (
          <p className="error" role="alert">
            {invalid.name}
          </p>
        )}
      </div>
      <VisibilityFields value={sharing} onChange={setSharing} groupError={invalid.group} />
      {importRoute.isError && <ErrorMessage error={importRoute.error} ns="trails" />}
      {importRoute.isPending && <p role="status">{t("osm.importing")}</p>}
      <div>
        <button className="btn btn-primary" disabled={importRoute.isPending}>
          {t("osm.import")}
        </button>
      </div>
    </form>
  );
}

function RouteDescription({ route }: { route: OsmRoute }) {
  const { t } = useTranslation("trails");
  const way = [route.start_name, route.end_name].filter(Boolean).join(" – ");
  return (
    <div>
      <strong>{route.name ?? t("osm.unnamed")}</strong>
      {way && <div className="muted">{way}</div>}
      {route.ref && <span className="badge">{route.ref}</span>}
    </div>
  );
}

export function OsmImportPage() {
  const { t } = useTranslation("trails");
  const [text, setText] = useState("");
  const [onlyVisible, setOnlyVisible] = useState(false);
  const [visibleArea, setVisibleArea] = useState<string | null>(null);
  const [tooShort, setTooShort] = useState(false);
  const [search, setSearch] = useState<{ q: string; bbox: string | null } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const results = useOsmSearch(search);
  const preview = useOsmPreview(selected);

  function submit(event: FormEvent) {
    event.preventDefault();
    const q = text.trim();
    const short = q.length < MIN_SEARCH_LENGTH;
    setTooShort(short);
    if (short) return;
    setSelected(null);
    setSearch({ q, bbox: onlyVisible ? visibleArea : null });
  }

  return (
    <>
      <p>
        <Link to="/trails">{t("backToList")}</Link>
      </p>
      <h1>{t("osm.title")}</h1>

      <form className="form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="osm-search">{t("osm.search")}</label>
          <input
            id="osm-search"
            type="search"
            value={text}
            maxLength={100}
            onChange={(event) => setText(event.target.value)}
          />
          {tooShort && (
            <p className="error" role="alert">
              {t("errors.osm_search_too_short")}
            </p>
          )}
        </div>
        <label className="check-field">
          <input
            type="checkbox"
            checked={onlyVisible}
            disabled={visibleArea === null}
            onChange={(event) => setOnlyVisible(event.target.checked)}
          />
          {t("osm.onlyVisible")}
        </label>
        <div>
          <button className="btn btn-primary" disabled={results.isFetching}>
            {t("osm.searchButton")}
          </button>
        </div>
      </form>

      {results.isFetching && (
        <p className="muted" role="status">
          {t("osm.searching")}
        </p>
      )}
      {results.isError && !results.isFetching && <ErrorMessage error={results.error} ns="trails" />}
      {results.data && !results.isFetching && results.data.items.length === 0 && (
        <p className="muted">{t("osm.noResults")}</p>
      )}
      {results.data && !results.isFetching && results.data.items.length > 0 && (
        <ul className="osm-results" aria-label={t("osm.results")}>
          {results.data.items.map((route) => (
            <li key={route.relation_id} className="card osm-result">
              <RouteDescription route={route} />
              <button
                className="btn"
                aria-pressed={selected === route.relation_id}
                onClick={() => setSelected(route.relation_id)}
              >
                {t("osm.preview", { name: route.name ?? t("osm.unnamed") })}
              </button>
            </li>
          ))}
        </ul>
      )}

      <section className="trail-section">
        <LazyTrailMap
          geometry={preview.data?.geometry ?? null}
          label={t("osm.mapLabel")}
          onVisibleAreaChange={setVisibleArea}
        />
        <OsmAttribution relationId={selected} />
      </section>

      {preview.isFetching && <Loading />}
      {preview.isError && !preview.isFetching && <ErrorMessage error={preview.error} ns="trails" />}
      {preview.data && !preview.isFetching && (
        <ImportForm key={preview.data.relation_id} preview={preview.data} />
      )}
    </>
  );
}
