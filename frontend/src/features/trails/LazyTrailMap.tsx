import { Component, lazy, Suspense } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Loading } from "../../components/Loading";
import type { LineString } from "./api";

export interface TrailMapProps {
  geometry?: LineString | null;
  /** Accessible name of the map. */
  label: string;
  /** Called with "west,south,east,north" when the map appears and after every move. */
  onVisibleAreaChange?: (bbox: string) => void;
}

const TrailMap = lazy(() => import("./TrailMap"));

class LoadBoundary extends Component<{ fallback: ReactNode; children: ReactNode }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** The map, with MapLibre loaded only when one is actually shown. */
export function LazyTrailMap(props: TrailMapProps) {
  const { t } = useTranslation("trails");
  return (
    <LoadBoundary fallback={<p className="muted">{t("map.unavailable")}</p>}>
      <Suspense fallback={<Loading />}>
        <TrailMap {...props} />
      </Suspense>
    </LoadBoundary>
  );
}
