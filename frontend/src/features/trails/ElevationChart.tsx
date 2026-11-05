import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { useFormat } from "../../lib/format";

const HEIGHT = 240;
const MARGIN = { top: 28, right: 16, bottom: 42, left: 56 };
const DEFAULT_WIDTH = 640;
/** Pixels per axis label, so that a phone gets fewer of them instead of overlapping ones. */
const X_TICK_SPACING = 80;
const Y_TICK_COUNT = 4;

/** Round tick values covering a range: steps of 1, 2 or 5 times a power of ten. */
export function niceTicks(min: number, max: number, count: number): number[] {
  const rough = Math.max(max - min, 1e-9) / Math.max(count, 1);
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((value) => value >= rough)!;
  const ticks = [];
  for (let tick = Math.ceil(min / step) * step; tick <= max + step * 1e-6; tick += step) {
    ticks.push(Number(tick.toFixed(10)));
  }
  return ticks;
}

function useWidth() {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

export function ElevationChart({
  profile,
  highestPoint,
}: {
  profile: [number, number][];
  /** The trail's highest point, which smoothing can have taken off the profile itself. */
  highestPoint?: number | null;
}) {
  const { t } = useTranslation("trails");
  const format = useFormat();
  const { ref, width } = useWidth();
  const [hovered, setHovered] = useState<number | null>(null);

  if (profile.length < 2) return null;

  const heights = profile.map(([, height]) => height);
  const lowest = Math.min(...heights);
  const highest = Math.max(...heights);
  const distance = profile[profile.length - 1][0];

  // A small range would otherwise make a flat trail look like a mountain.
  const padding = Math.max((highest - lowest) * 0.1, 10);
  const yTicks = niceTicks(lowest - padding, highest + padding, Y_TICK_COUNT);
  const yMin = Math.min(yTicks[0], lowest);
  const yMax = Math.max(yTicks[yTicks.length - 1], highest);

  const plotWidth = Math.max(width - MARGIN.left - MARGIN.right, 1);
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const x = (metres: number) => MARGIN.left + (metres / distance) * plotWidth;
  const y = (height: number) => MARGIN.top + (1 - (height - yMin) / (yMax - yMin)) * plotHeight;
  const xTicks = niceTicks(0, distance / 1000, Math.max(Math.floor(plotWidth / X_TICK_SPACING), 1));

  const line = profile
    .map(([metres, height]) => `${x(metres).toFixed(1)},${y(height).toFixed(1)}`)
    .join(" L");
  const baseline = (HEIGHT - MARGIN.bottom).toFixed(1);
  const area = `M${x(0).toFixed(1)},${baseline} L${line} L${x(distance).toFixed(1)},${baseline} Z`;

  const summary = t("chart.summary", {
    distance: format.distance(distance),
    start: format.elevation(heights[0]),
    end: format.elevation(heights[heights.length - 1]),
    lowest: format.elevation(lowest),
    highest: format.elevation(highestPoint ?? highest),
  });

  function trackPointer(event: PointerEvent<SVGRectElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    const metres = ((event.clientX - box.left) / box.width) * distance;
    let nearest = 0;
    profile.forEach(([position], index) => {
      if (Math.abs(position - metres) < Math.abs(profile[nearest][0] - metres)) nearest = index;
    });
    setHovered(nearest);
  }

  const point = hovered === null ? null : profile[hovered];
  const tooltipLeft = point
    ? Math.min(Math.max(x(point[0]), MARGIN.left + 50), width - MARGIN.right - 50)
    : 0;

  return (
    <figure ref={ref} className="elevation-chart">
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        height={HEIGHT}
        role="img"
        aria-label={t("chart.title")}
        aria-describedby="elevation-summary"
      >
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              className="elevation-grid"
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text x={MARGIN.left - 6} y={y(tick) + 4} textAnchor="end">
              {format.number(tick)}
            </text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <text key={tick} x={x(tick * 1000)} y={HEIGHT - MARGIN.bottom + 16} textAnchor="middle">
            {format.number(tick)}
          </text>
        ))}
        <text x={MARGIN.left + plotWidth / 2} y={HEIGHT - 6} textAnchor="middle">
          {t("chart.distanceAxis")}
        </text>
        <text x={4} y={14}>
          {t("chart.elevationAxis")}
        </text>
        <path className="elevation-area" d={area} />
        <path className="elevation-line" d={`M${line}`} />
        {point && (
          <>
            <line
              className="elevation-crosshair"
              x1={x(point[0])}
              x2={x(point[0])}
              y1={MARGIN.top}
              y2={HEIGHT - MARGIN.bottom}
            />
            <circle className="elevation-marker" cx={x(point[0])} cy={y(point[1])} r={5} />
          </>
        )}
        {/* Larger than the line, so that it is easy to hit with a finger. */}
        <rect
          data-testid="elevation-hit-area"
          x={MARGIN.left}
          y={MARGIN.top}
          width={plotWidth}
          height={plotHeight}
          fill="transparent"
          onPointerDown={trackPointer}
          onPointerMove={trackPointer}
          onPointerLeave={() => setHovered(null)}
        />
      </svg>
      {point && (
        <div className="elevation-tooltip" role="status" style={{ left: tooltipLeft }}>
          {format.distance(point[0])} · {format.elevation(point[1])}
        </div>
      )}
      <figcaption id="elevation-summary" className="muted">
        {summary}
      </figcaption>
    </figure>
  );
}
