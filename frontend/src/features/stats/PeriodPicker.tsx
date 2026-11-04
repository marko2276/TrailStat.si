import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Period, PeriodKind } from "./period";

const KINDS: PeriodKind[] = ["all", "day", "month", "year"];
const EARLIEST_YEAR = 1900;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** The year as typed: while it's incomplete, the last valid year stays selected. */
function YearInput({ year, onChange }: { year: number; onChange: (year: number) => void }) {
  const { t } = useTranslation("stats");
  const [text, setText] = useState(String(year));

  return (
    <div className="field">
      <label htmlFor="period-year">{t("year")}</label>
      <input
        id="period-year"
        type="number"
        inputMode="numeric"
        min={EARLIEST_YEAR}
        max={9999}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          const typed = Number(event.target.value);
          if (Number.isInteger(typed) && typed >= EARLIEST_YEAR && typed <= 9999) onChange(typed);
        }}
      />
    </div>
  );
}

export function PeriodPicker({
  period,
  onChange,
}: {
  period: Period;
  onChange: (period: Period) => void;
}) {
  const { t, i18n } = useTranslation("stats");
  const language = i18n.resolvedLanguage ?? "en";
  const { kind, date } = period;
  const [year, month] = date.split("-").map(Number);

  // Month names only: not a value to format, but an option to pick.
  const monthNames = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(language, { month: "long" });
    return Array.from({ length: 12 }, (_, index) => formatter.format(new Date(2024, index, 1)));
  }, [language]);

  return (
    <div className="actions" style={{ alignItems: "flex-end" }}>
      <div className="field">
        <label htmlFor="period-kind">{t("period")}</label>
        <select
          id="period-kind"
          value={kind}
          onChange={(event) => onChange({ kind: event.target.value as PeriodKind, date })}
        >
          {KINDS.map((option) => (
            <option key={option} value={option}>
              {t(`periods.${option}`)}
            </option>
          ))}
        </select>
      </div>
      {kind === "day" && (
        <div className="field">
          <label htmlFor="period-date">{t("day")}</label>
          <input
            id="period-date"
            type="date"
            value={date}
            onChange={(event) => {
              // While it's cleared or a year is half typed, the selected day stays as it was.
              const typed = event.target.value;
              if (/^\d{4}-/.test(typed) && Number(typed.slice(0, 4)) >= EARLIEST_YEAR) {
                onChange({ kind, date: typed });
              }
            }}
          />
        </div>
      )}
      {kind === "month" && (
        <div className="field">
          <label htmlFor="period-month">{t("month")}</label>
          <select
            id="period-month"
            value={month}
            onChange={(event) =>
              onChange({ kind, date: `${year}-${pad(Number(event.target.value))}-01` })
            }
          >
            {monthNames.map((name, index) => (
              <option key={name} value={index + 1}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}
      {(kind === "month" || kind === "year") && (
        <YearInput
          year={year}
          onChange={(next) => onChange({ kind, date: `${next}-${pad(month)}-01` })}
        />
      )}
    </div>
  );
}
