import { describe, expect, it } from "vitest";
import { measureRoute, pointAt, shareNearest } from "./routeMeasure";

// East along a parallel for about 772 m, then north for about 2,224 m.
const route = measureRoute([
  [14.0, 46.0],
  [14.01, 46.0],
  [14.01, 46.02],
]);

describe("measuring a route", () => {
  it("adds up its legs, in metres", () => {
    // 0.01 degree of longitude at 46 degrees north is about 772 m, of latitude about 1,112 m.
    expect(route.along[1]).toBeCloseTo(772, -1);
    expect(route.length).toBeCloseTo(772 + 2224, -1);
  });

  it("finds the point at a share of its length, also on a later leg", () => {
    expect(pointAt(route, 0)).toEqual([14.0, 46.0]);
    expect(pointAt(route, 1)).toEqual([14.01, 46.02]);
    const [lon, lat] = pointAt(route, (772 + 1112) / route.length)!;
    expect(lon).toBeCloseTo(14.01, 6);
    expect(lat).toBeCloseTo(46.01, 3);
  });

  it("keeps shares outside the route at its ends", () => {
    expect(pointAt(route, -1)).toEqual([14.0, 46.0]);
    expect(pointAt(route, 2)).toEqual([14.01, 46.02]);
  });

  it("finds the share of the route's point nearest to a position beside it", () => {
    // Just north of the middle of the first leg.
    expect(shareNearest(route, [14.005, 46.0005])).toBeCloseTo(386 / route.length, 2);
    // East of the second leg, level with its middle.
    expect(shareNearest(route, [14.02, 46.01])).toBeCloseTo((772 + 1112) / route.length, 2);
    // Beyond the end.
    expect(shareNearest(route, [14.01, 46.5])).toBe(1);
  });

  it("goes there and back: the nearest share to a point on the route is its own", () => {
    for (const share of [0.1, 0.33, 0.5, 0.9]) {
      expect(shareNearest(route, pointAt(route, share)!)).toBeCloseTo(share, 6);
    }
  });

  it("copes with routes without length", () => {
    const still = measureRoute([
      [14, 46],
      [14, 46],
    ]);
    expect(pointAt(still, 0.5)).toEqual([14, 46]);
    expect(shareNearest(still, [15, 47])).toBe(0);
    expect(pointAt(measureRoute([]), 0.5)).toBeNull();
  });
});
