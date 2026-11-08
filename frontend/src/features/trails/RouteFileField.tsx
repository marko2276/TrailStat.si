import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { ErrorMessage } from "../../components/ErrorMessage";
import { useFormat } from "../../lib/format";
import { usePreviewRoute } from "./api";
import type { RouteGeometry, RoutePreview } from "./api";
import { ElevationChart } from "./ElevationChart";
import { LazyTrailMap } from "./LazyTrailMap";
import { readRouteFile, RouteFileError } from "./routeFile";
import type { RouteFileProblem } from "./routeFile";

export interface LoadedRoute {
  fileName: string;
  /** The route's name in the file, if it has one. */
  name: string | null;
  /** All the file's points, which the server measures again when the trail is saved. */
  geometry: RouteGeometry;
  preview: RoutePreview;
}

/** A trail's route, loaded from a GPX or KML file, with a preview of what the trail would get. */
export function RouteFileField({
  value,
  onChange,
}: {
  value: LoadedRoute | null;
  onChange: (route: LoadedRoute | null) => void;
}) {
  const { t } = useTranslation("trails");
  const format = useFormat();
  const preview = usePreviewRoute();
  const input = useRef<HTMLInputElement>(null);
  // Only the latest file counts, if the user picks another before the first is done.
  const latest = useRef(0);
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<RouteFileProblem | null>(null);

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const attempt = ++latest.current;
    setProblem(null);
    preview.reset();
    onChange(null);
    if (!file) return;

    setReading(true);
    try {
      const route = await readRouteFile(file);
      if (attempt !== latest.current) return;
      const geometry: RouteGeometry = { type: "LineString", coordinates: route.coordinates };
      preview.mutate(geometry, {
        onSuccess: (result) => {
          if (attempt === latest.current) {
            onChange({ fileName: file.name, name: route.name, geometry, preview: result });
          }
        },
      });
    } catch (error) {
      if (attempt !== latest.current) return;
      setProblem(error instanceof RouteFileError ? error.problem : "unreadable");
    } finally {
      if (attempt === latest.current) setReading(false);
    }
  }

  function remove() {
    latest.current++;
    preview.reset();
    setProblem(null);
    onChange(null);
    if (input.current) input.current.value = "";
  }

  const unknown = t("unknown");
  const elevation = (metres: number | null) =>
    metres === null ? unknown : format.elevation(metres);
  const shown = value?.preview;

  return (
    <div className="field">
      <label htmlFor="trail-route-file">{t("routeFile.label")}</label>
      <input
        ref={input}
        id="trail-route-file"
        type="file"
        accept=".gpx,.kml,application/gpx+xml,application/vnd.google-earth.kml+xml"
        aria-describedby="trail-route-file-hint"
        onChange={(event) => void choose(event)}
      />
      <p id="trail-route-file-hint" className="muted">
        {t("routeFile.hint")}
      </p>
      {(reading || preview.isPending) && <p role="status">{t("routeFile.reading")}</p>}
      {problem && (
        <p className="error" role="alert">
          {t(`routeFile.problems.${problem}`)}
        </p>
      )}
      {preview.isError && <ErrorMessage error={preview.error} ns="trails" />}

      {value && shown && (
        <div className="card route-preview">
          <p className="trail-name">
            <strong>{value.fileName}</strong>
          </p>
          <dl className="stat-grid">
            <div>
              <dt className="muted">{t("fields.distance")}</dt>
              <dd className="stat-value">{format.distance(shown.distance_m)}</dd>
            </div>
            <div>
              <dt className="muted">{t("fields.gain")}</dt>
              <dd className="stat-value">{elevation(shown.elevation_gain_m)}</dd>
            </div>
            <div>
              <dt className="muted">{t("fields.loss")}</dt>
              <dd className="stat-value">{elevation(shown.elevation_loss_m)}</dd>
            </div>
            <div>
              <dt className="muted">{t("fields.highest")}</dt>
              <dd className="stat-value">{elevation(shown.highest_point_m)}</dd>
            </div>
          </dl>
          <LazyTrailMap geometry={shown.geometry} label={t("routeFile.mapLabel")} />
          {shown.elevation_profile && shown.elevation_profile.length >= 2 && (
            <ElevationChart
              profile={shown.elevation_profile}
              highestPoint={shown.highest_point_m}
            />
          )}
          <ElevationNote source={shown.elevation_source} />
          <p className="muted">{t("routeFile.measuredFromRoute")}</p>
          <div>
            <button type="button" className="btn" onClick={remove}>
              {t("routeFile.remove")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Where a trail's elevation figures came from, with the attribution the DEM needs. */
export function ElevationNote({ source }: { source: RoutePreview["elevation_source"] }) {
  const { t } = useTranslation("trails");
  if (source === "dem") return <p className="attribution muted">{t("copernicusAttribution")}</p>;
  if (source === "file") return <p className="muted">{t("routeFile.heightsFromFile")}</p>;
  return (
    <p className="muted" role="note">
      {t("routeFile.noElevation")}
    </p>
  );
}
