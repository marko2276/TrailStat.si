import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { periodRange } from "./period";

function hoursBetween({ start_from, start_to }: { start_from?: string; start_to?: string }) {
  return (Date.parse(start_to!) - Date.parse(start_from!)) / 3_600_000;
}

function inTimeZone(zone: string, tests: () => void) {
  describe(zone, () => {
    const original = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = zone;
    });
    afterAll(() => {
      process.env.TZ = original;
    });
    tests();
  });
}

inTimeZone("Europe/Ljubljana", () => {
  it("really runs in the time zone", () => {
    expect(new Date(2024, 0, 15).getTimezoneOffset()).toBe(-60);
    expect(new Date(2024, 6, 15).getTimezoneOffset()).toBe(-120);
  });

  it("all time has no bounds", () => {
    expect(periodRange({ kind: "all", date: "2024-03-31" })).toEqual({});
  });

  it("an ordinary day is 24 hours from local midnight", () => {
    const range = periodRange({ kind: "day", date: "2024-07-15" });
    expect(range).toEqual({
      start_from: "2024-07-14T22:00:00.000Z",
      start_to: "2024-07-15T22:00:00.000Z",
    });
  });

  it("the day clocks go forward lasts 23 hours", () => {
    const range = periodRange({ kind: "day", date: "2024-03-31" });
    expect(range).toEqual({
      start_from: "2024-03-30T23:00:00.000Z",
      start_to: "2024-03-31T22:00:00.000Z",
    });
    expect(hoursBetween(range)).toBe(23);
  });

  it("the day clocks go back lasts 25 hours", () => {
    const range = periodRange({ kind: "day", date: "2024-10-27" });
    expect(range).toEqual({
      start_from: "2024-10-26T22:00:00.000Z",
      start_to: "2024-10-27T23:00:00.000Z",
    });
    expect(hoursBetween(range)).toBe(25);
  });

  it("the month with the forward change starts and ends on local midnights", () => {
    const range = periodRange({ kind: "month", date: "2024-03-15" });
    expect(range).toEqual({
      start_from: "2024-02-29T23:00:00.000Z",
      start_to: "2024-03-31T22:00:00.000Z",
    });
    expect(hoursBetween(range)).toBe(31 * 24 - 1);
  });

  it("the month with the backward change is an hour longer", () => {
    const range = periodRange({ kind: "month", date: "2024-10-01" });
    expect(range).toEqual({
      start_from: "2024-09-30T22:00:00.000Z",
      start_to: "2024-10-31T23:00:00.000Z",
    });
    expect(hoursBetween(range)).toBe(31 * 24 + 1);
  });

  it("the last day and month of a year roll over", () => {
    expect(periodRange({ kind: "day", date: "2024-12-31" }).start_to).toBe(
      "2024-12-31T23:00:00.000Z",
    );
    expect(periodRange({ kind: "month", date: "2024-12-31" }).start_to).toBe(
      "2024-12-31T23:00:00.000Z",
    );
  });

  it("a year runs between local new years", () => {
    expect(periodRange({ kind: "year", date: "2024-07-15" })).toEqual({
      start_from: "2023-12-31T23:00:00.000Z",
      start_to: "2024-12-31T23:00:00.000Z",
    });
  });
});

inTimeZone("America/New_York", () => {
  it("uses that zone's own change date", () => {
    const range = periodRange({ kind: "day", date: "2024-03-10" });
    expect(range).toEqual({
      start_from: "2024-03-10T05:00:00.000Z",
      start_to: "2024-03-11T04:00:00.000Z",
    });
    expect(hoursBetween(range)).toBe(23);
  });
});

inTimeZone("America/Havana", () => {
  it("starts the day at the first valid moment when midnight doesn't exist", () => {
    // In Cuba clocks go from 00:00 to 01:00, so this day has no midnight.
    const range = periodRange({ kind: "day", date: "2024-03-10" });
    expect(range.start_from).toBe("2024-03-10T05:00:00.000Z");
    expect(hoursBetween(range)).toBe(23);
  });
});
