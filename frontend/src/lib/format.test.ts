import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDistance,
  formatDuration,
  formatElevation,
  formatNumber,
} from "./format";

// Intl separates some units with a no-break space.
const plain = (value: string) => value.replace(/\s/g, " ");

describe("formatting follows the locale", () => {
  it("uses a decimal comma in Slovenian and a point in English", () => {
    expect(plain(formatDistance(12500, "sl"))).toBe("12,5 km");
    expect(plain(formatDistance(12500, "en"))).toBe("12.5 km");
  });

  it("groups thousands per locale", () => {
    expect(plain(formatNumber(1234567, "en"))).toBe("1,234,567");
    expect(plain(formatNumber(1234567, "sl"))).toBe("1.234.567");
  });

  it("formats elevation in metres without decimals", () => {
    expect(plain(formatElevation(1864.4, "sl"))).toBe("1864 m");
  });

  it("orders dates per locale", () => {
    const date = new Date(2026, 9, 12, 12);
    expect(plain(formatDate(date, "en"))).toBe("Oct 12, 2026");
    expect(plain(formatDate(date, "sl"))).toMatch(/^12\. ?(okt\.?|10\.) ?2026$/);
  });
});

describe("formatDuration", () => {
  it.each([
    [15300, "4 hr 15 min"],
    [3600, "1 hr"],
    [2700, "45 min"],
    [0, "0 min"],
    [89, "1 min"],
    [3599, "1 hr"],
  ])("%i seconds is %s", (seconds, expected) => {
    expect(plain(formatDuration(seconds, "en"))).toBe(expected);
  });

  it("is localised", () => {
    expect(plain(formatDuration(15300, "sl"))).toBe("4 h 15 min");
  });
});
