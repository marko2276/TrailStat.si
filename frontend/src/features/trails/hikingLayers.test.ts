import { describe, expect, it } from "vitest";
import { HIKING_LAYERS } from "./hikingLayers";

const byId = (id: string) => HIKING_LAYERS.find((layer) => layer.id === id)!;

describe("hiking layers", () => {
  it("come from the base map's own tiles, so nothing else is downloaded", () => {
    for (const layer of HIKING_LAYERS) {
      expect(layer.source).toBe("openmaptiles");
      expect(layer["source-layer"]).toBe("transportation");
    }
  });

  it("show tracks, and paths without cycle paths, from zoom 12", () => {
    expect(byId("hiking-tracks").filter).toEqual(["==", ["get", "class"], "track"]);
    expect(JSON.stringify(byId("hiking-paths").filter)).toContain('"path"');
    expect(JSON.stringify(byId("hiking-paths").filter)).toContain('"cycleway"');
    expect(HIKING_LAYERS.every((layer) => layer.minzoom === 12)).toBe(true);
  });

  it("are dashed in different colours, so paths and tracks can be told apart", () => {
    const paint = HIKING_LAYERS.map((layer) => layer.paint!);
    expect(paint.every((p) => Array.isArray(p["line-dasharray"]))).toBe(true);
    expect(paint[0]["line-color"]).not.toBe(paint[1]["line-color"]);
  });
});
