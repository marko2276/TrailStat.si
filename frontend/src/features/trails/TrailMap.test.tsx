import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "../../test/render";
import type { LineString } from "./api";
import TrailMap from "./TrailMap";

/** Just enough of MapLibre to see what the component asks of it. jsdom has no WebGL. */
const fake = vi.hoisted(() => {
  class FakeMap {
    static instances: FakeMap[] = [];
    static failing = false;
    handlers = new Map<string, () => void>();
    sources = new Map<string, { data: unknown; setData: (data: unknown) => void }>();
    layers: string[] = [];
    /** Where each layer was put: the layer it went below, if any. */
    below = new Map<string, string | undefined>();
    style: { sources: Record<string, { type: string }>; layers: { id: string; type: string }[] } = {
      sources: {},
      layers: [],
    };
    fitted: unknown[] = [];
    removed = false;
    bounds = { west: 13, south: 45, east: 15, north: 47 };

    constructor(public options: Record<string, unknown>) {
      if (FakeMap.failing) throw new Error("WebGL is not supported");
      FakeMap.instances.push(this);
    }
    on(event: string, handler: () => void) {
      this.handlers.set(event, handler);
    }
    fire(event: string) {
      this.handlers.get(event)?.();
    }
    addSource(id: string, source: { data: unknown }) {
      const entry = {
        data: source.data,
        setData(data: unknown) {
          entry.data = data;
        },
      };
      this.sources.set(id, entry);
    }
    getSource(id: string) {
      return this.sources.get(id);
    }
    addLayer(layer: { id: string }, before?: string) {
      this.layers.push(layer.id);
      this.below.set(layer.id, before);
    }
    getStyle() {
      return this.style;
    }
    fitBounds(bounds: unknown) {
      this.fitted.push(bounds);
    }
    getBounds() {
      const { west, south, east, north } = this.bounds;
      return {
        getWest: () => west,
        getSouth: () => south,
        getEast: () => east,
        getNorth: () => north,
      };
    }
    remove() {
      this.removed = true;
    }
  }
  class FakeBounds {
    points: unknown[] = [];
    extend(point: unknown) {
      this.points.push(point);
    }
  }
  return { FakeMap, FakeBounds, setWorkerUrl: vi.fn() };
});

vi.mock("maplibre-gl", () => ({
  Map: fake.FakeMap,
  LngLatBounds: fake.FakeBounds,
  setWorkerUrl: fake.setWorkerUrl,
}));

const line: LineString = {
  type: "LineString",
  coordinates: [
    [13.8, 46.4],
    [13.9, 46.5],
  ],
};

function theMap() {
  return fake.FakeMap.instances.at(-1)!;
}

describe("TrailMap", () => {
  beforeEach(() => {
    fake.FakeMap.instances = [];
    fake.FakeMap.failing = false;
  });

  it("tells MapLibre where its worker is, without which no tiles load", () => {
    render(<TrailMap label="Map" />);

    expect(fake.setWorkerUrl).toHaveBeenCalledWith(expect.stringContaining("maplibre-gl-worker"));
  });

  it("uses the default style, which needs no key and is not openstreetmap.org", () => {
    render(<TrailMap label="Map" />);

    const style = theMap().options.style as string;
    expect(style).toBe("https://tiles.openfreemap.org/styles/liberty");
    expect(style).not.toContain("openstreetmap.org");
  });

  it("credits OpenStreetMap on the map itself", () => {
    render(<TrailMap label="Map" />);

    const attribution = theMap().options.attributionControl as { customAttribution: string };
    expect(attribution.customAttribution).toContain("OpenStreetMap contributors");
    expect(attribution.customAttribution).toContain("https://www.openstreetmap.org/copyright");
  });

  it("has an accessible name", () => {
    render(<TrailMap label="Map of Krim" />);

    expect(screen.getByRole("region", { name: "Map of Krim" })).toBeTruthy();
  });

  it("draws footpaths and tracks as on a hiking map, below labels and the trail", () => {
    render(<TrailMap label="Map" geometry={line} />);
    const map = theMap();
    map.style = {
      sources: { openmaptiles: { type: "vector" } },
      layers: [
        { id: "background", type: "background" },
        { id: "road_path_pedestrian", type: "line" },
        { id: "road_one_way_arrow", type: "symbol" },
        { id: "place_label", type: "symbol" },
      ],
    };

    act(() => map.fire("load"));

    expect(map.layers).toEqual(["hiking-tracks", "hiking-paths", "route-outline", "route"]);
    expect(map.below.get("hiking-tracks")).toBe("road_one_way_arrow");
    expect(map.below.get("hiking-paths")).toBe("road_one_way_arrow");
    // The trail's line goes on top of everything.
    expect(map.below.get("route")).toBeUndefined();
  });

  it("leaves a style without those tiles alone", () => {
    render(<TrailMap label="Map" geometry={line} />);
    const map = theMap();

    act(() => map.fire("load"));

    expect(map.layers).toEqual(["route-outline", "route"]);
  });

  it("draws the line and zooms to it once the map has loaded", () => {
    render(<TrailMap label="Map" geometry={line} />);
    const map = theMap();
    expect(map.layers).toEqual([]);

    act(() => map.fire("load"));

    expect(map.layers).toContain("route");
    const data = map.sources.get("route")!.data as { geometry: LineString };
    expect(data.geometry.coordinates).toEqual(line.coordinates);
    expect(map.fitted.length).toBeGreaterThan(0);
  });

  it("shows a new line when the previewed route changes, without a new map", async () => {
    function Switchable() {
      const [geometry, setGeometry] = useState<LineString | null>(null);
      return (
        <>
          <button onClick={() => setGeometry(line)}>show line</button>
          <TrailMap label="Map" geometry={geometry} />
        </>
      );
    }
    render(<Switchable />);
    const map = theMap();
    act(() => map.fire("load"));
    expect(map.fitted).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: "show line" }));

    await waitFor(() => {
      const data = map.sources.get("route")!.data as { geometry: LineString };
      expect(data.geometry.coordinates).toEqual(line.coordinates);
    });
    expect(map.fitted).toHaveLength(1);
    expect(fake.FakeMap.instances).toHaveLength(1);
    expect(map.removed).toBe(false);
  });

  it("reports the visible area at once, without waiting for tiles, and after moving", () => {
    const onChange = vi.fn();
    render(<TrailMap label="Map" onVisibleAreaChange={onChange} />);
    const map = theMap();

    expect(onChange).toHaveBeenLastCalledWith("13.00000,45.00000,15.00000,47.00000");

    map.bounds = { west: 14, south: 46, east: 14.5, north: 46.5 };
    act(() => map.fire("moveend"));
    expect(onChange).toHaveBeenLastCalledWith("14.00000,46.00000,14.50000,46.50000");
  });

  it("keeps the visible area within the valid range when zoomed far out", () => {
    const onChange = vi.fn();
    render(<TrailMap label="Map" onVisibleAreaChange={onChange} />);
    const map = theMap();
    map.bounds = { west: -500, south: -95, east: 700, north: 95 };

    act(() => map.fire("moveend"));

    expect(onChange).toHaveBeenLastCalledWith("-180.00000,-90.00000,180.00000,90.00000");
  });

  it("removes the map when leaving the page", () => {
    const view = render(<TrailMap label="Map" />);

    view.unmount();

    expect(theMap().removed).toBe(true);
  });

  it("says so when the device cannot show a map", async () => {
    fake.FakeMap.failing = true;
    render(<TrailMap label="Map" />);

    expect(await screen.findByText("The map could not be shown on this device.")).toBeTruthy();
  });
});
