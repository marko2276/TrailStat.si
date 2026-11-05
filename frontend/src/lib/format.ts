import { useTranslation } from "react-i18next";

/** Locale-aware formatting. Values are stored in UTC, metres and seconds. */

export function formatDate(value: string | Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value));
}

export function formatDateTime(value: string | Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatDistance(metres: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "kilometer",
    maximumFractionDigits: 1,
  }).format(metres / 1000);
}

export function formatElevation(metres: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "meter",
    maximumFractionDigits: 0,
  }).format(metres);
}

export function formatDuration(seconds: number, locale: string): string {
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const unit = (value: number, name: "hour" | "minute") =>
    new Intl.NumberFormat(locale, { style: "unit", unit: name }).format(value);
  if (hours === 0) return unit(minutes, "minute");
  if (minutes === 0) return unit(hours, "hour");
  return `${unit(hours, "hour")} ${unit(minutes, "minute")}`;
}

/** The formatters above, bound to the current language. Re-renders when it changes. */
export function useFormat() {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";
  return {
    date: (value: string | Date) => formatDate(value, locale),
    dateTime: (value: string | Date) => formatDateTime(value, locale),
    number: (value: number) => formatNumber(value, locale),
    distance: (metres: number) => formatDistance(metres, locale),
    elevation: (metres: number) => formatElevation(metres, locale),
    duration: (seconds: number) => formatDuration(seconds, locale),
  };
}
