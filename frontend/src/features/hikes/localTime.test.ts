import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromLocalInputs, toDateInput, toOffsetIso, toTimeInput } from "./localTime";

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
  it("uses the offset that applies on that date, not today's", () => {
    expect(toOffsetIso(fromLocalInputs("2024-07-01", "09:30"))).toBe("2024-07-01T09:30:00+02:00");
    expect(toOffsetIso(fromLocalInputs("2024-01-15", "09:30"))).toBe("2024-01-15T09:30:00+01:00");
  });

  it("produces the right instant", () => {
    expect(fromLocalInputs("2024-07-01", "09:30").toISOString()).toBe("2024-07-01T07:30:00.000Z");
    expect(fromLocalInputs("2024-01-15", "09:30").toISOString()).toBe("2024-01-15T08:30:00.000Z");
  });

  it("handles the day clocks go forward, on either side of the change", () => {
    expect(toOffsetIso(fromLocalInputs("2024-03-31", "01:30"))).toBe("2024-03-31T01:30:00+01:00");
    expect(toOffsetIso(fromLocalInputs("2024-03-31", "03:30"))).toBe("2024-03-31T03:30:00+02:00");
  });

  it("moves a time that doesn't exist to a valid one", () => {
    expect(toOffsetIso(fromLocalInputs("2024-03-31", "02:30"))).toBe("2024-03-31T03:30:00+02:00");
  });

  it("converts an instant back to the local inputs", () => {
    const summer = new Date("2024-07-01T07:30:00Z");
    expect([toDateInput(summer), toTimeInput(summer)]).toEqual(["2024-07-01", "09:30"]);
    // Still the previous day in UTC.
    const newYear = new Date("2023-12-31T23:30:00Z");
    expect([toDateInput(newYear), toTimeInput(newYear)]).toEqual(["2024-01-01", "00:30"]);
  });
});

inTimeZone("America/New_York", () => {
  it("writes a negative offset", () => {
    expect(toOffsetIso(fromLocalInputs("2024-01-15", "09:30"))).toBe("2024-01-15T09:30:00-05:00");
  });
});

inTimeZone("Asia/Kolkata", () => {
  it("writes an offset with minutes", () => {
    expect(toOffsetIso(fromLocalInputs("2024-01-15", "09:30"))).toBe("2024-01-15T09:30:00+05:30");
  });
});

inTimeZone("America/St_Johns", () => {
  it("writes a negative offset with minutes", () => {
    expect(toOffsetIso(fromLocalInputs("2024-01-15", "09:30"))).toBe("2024-01-15T09:30:00-03:30");
  });
});
