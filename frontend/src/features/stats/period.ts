/**
 * Periods are calendar ranges in the user's local time zone. Each bound comes from calendar fields,
 * never from adding 24 hours, so a day with a daylight saving change has its true 23 or 25 hours.
 */

export type PeriodKind = "all" | "day" | "month" | "year";

export interface Period {
  kind: PeriodKind;
  /** The selected local date, "YYYY-MM-DD". For a month or a year, any date inside it. */
  date: string;
}

export interface PeriodRange {
  start_from?: string;
  start_to?: string;
}

function localMidnight(year: number, monthIndex: number, day: number): string {
  return new Date(year, monthIndex, day).toISOString();
}

export function periodRange({ kind, date }: Period): PeriodRange {
  if (kind === "all") return {};
  const [year, month, day] = date.split("-").map(Number);
  const monthIndex = month - 1;
  switch (kind) {
    case "day":
      return {
        start_from: localMidnight(year, monthIndex, day),
        start_to: localMidnight(year, monthIndex, day + 1),
      };
    case "month":
      return {
        start_from: localMidnight(year, monthIndex, 1),
        start_to: localMidnight(year, monthIndex + 1, 1),
      };
    case "year":
      return {
        start_from: localMidnight(year, 0, 1),
        start_to: localMidnight(year + 1, 0, 1),
      };
  }
}
