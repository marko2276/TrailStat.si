/**
 * Date and time inputs hold the user's local wall-clock time; the API takes instants.
 * All conversions go through calendar fields, so the browser's rules for the local time zone
 * and its daylight saving changes apply.
 */

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/** "2026-03-29", as a date input holds it. */
export function toDateInput(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "09:30", as a time input holds it. */
export function toTimeInput(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The local date and time as a Date. A local time skipped by a daylight saving change (02:30 on
 * the night clocks go forward) moves to the valid time an hour later, as the browser resolves it.
 */
export function fromLocalInputs(date: string, time: string): Date {
  if (!date || !time) return new Date(NaN);
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  const result = new Date(year, month - 1, day, hours, minutes);
  // The constructor reads years 0-99 as 1900-1999.
  if (year < 100) result.setFullYear(year);
  return result;
}

/** "2026-07-01T09:30:00+02:00": the instant, with the local offset that applied at that time. */
export function toOffsetIso(date: Date): string {
  // Rounded: before standard time, zones had offsets with seconds.
  const offset = -Math.round(date.getTimezoneOffset());
  const sign = offset < 0 ? "-" : "+";
  const hours = Math.floor(Math.abs(offset) / 60);
  const minutes = Math.abs(offset) % 60;
  const seconds = pad(date.getSeconds());
  return (
    `${toDateInput(date)}T${toTimeInput(date)}:${seconds}` + `${sign}${pad(hours)}:${pad(minutes)}`
  );
}
