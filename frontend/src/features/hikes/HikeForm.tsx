import { useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ErrorMessage } from "../../components/ErrorMessage";
import { useFormat } from "../../lib/format";
import { useMyGroups } from "./api";
import type { Hike, HikeCreate, HikeUpdate, TrailOption } from "./api";
import { AttendeePicker } from "./AttendeePicker";
import { fromLocalInputs, toDateInput, toOffsetIso, toTimeInput } from "./localTime";
import { isTrailForGroup, TrailPicker } from "./TrailPicker";

// Matches the backend's limit.
const MAX_HOURS = 30 * 24;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const EARLIEST_YEAR = 1900;

type ChosenTrail = Pick<Hike["trail"], "id" | "name" | "distance_m" | "elevation_gain_m"> & {
  archived: boolean;
  /** Missing for a hike's current trail, which keeps its place whatever its visibility is now. */
  option?: TrailOption;
};

interface Common {
  error: unknown;
  isPending: boolean;
  onCancel: () => void;
}

interface CreateProps extends Common {
  hike?: undefined;
  currentUserId: string;
  initialGroupId: string | null;
  onCreate: (hike: HikeCreate) => void;
}

interface EditProps extends Common {
  hike: Hike;
  onUpdate: (update: HikeUpdate) => void;
}

function sameMembers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function isDefined(value: string | null): value is string {
  return value !== null;
}

/** 0 or less when the inputs make no sense, which the form reports as a missing duration. */
function toDurationSeconds(hours: string, minutes: string): number {
  const wholeHours = Number(hours) || 0;
  const wholeMinutes = Number(minutes) || 0;
  if (wholeHours < 0 || wholeMinutes < 0) return 0;
  return Math.round(wholeHours * SECONDS_PER_HOUR + wholeMinutes * SECONDS_PER_MINUTE);
}

export function HikeForm(props: CreateProps | EditProps) {
  const { t } = useTranslation("hikes");
  const format = useFormat();
  const { hike, error, isPending, onCancel } = props;
  const groups = useMyGroups();

  const [now] = useState(() => new Date());
  const initialStart = hike ? new Date(hike.start_at) : null;
  const initialDate = initialStart ? toDateInput(initialStart) : toDateInput(now);
  const initialTime = initialStart ? toTimeInput(initialStart) : "";
  const initialHours = hike ? Math.floor(hike.duration_s / SECONDS_PER_HOUR) : 0;
  const initialMinutes = hike
    ? Math.floor((hike.duration_s % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)
    : 0;
  const initialUserIds = hike ? hike.attendees.map((a) => a.user_id).filter(isDefined) : [];
  const initialGuestIds = hike ? hike.attendees.map((a) => a.guest_id).filter(isDefined) : [];

  const [trail, setTrail] = useState<ChosenTrail | null>(hike ? hike.trail : null);
  const [choosingTrail, setChoosingTrail] = useState(false);
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState(initialTime);
  const [hours, setHours] = useState(hike ? String(initialHours) : "");
  const [minutes, setMinutes] = useState(hike ? String(initialMinutes) : "");
  const [notes, setNotes] = useState(hike ? (hike.notes ?? "") : "");
  const [groupId, setGroupId] = useState<string | null>(
    props.hike ? props.hike.group_id : props.initialGroupId,
  );
  const [userIds, setUserIds] = useState<string[]>(() => {
    if (props.hike) return initialUserIds;
    return props.initialGroupId ? [props.currentUserId] : [];
  });
  const [guestIds, setGuestIds] = useState<string[]>(initialGuestIds);
  const [problem, setProblem] = useState<string | null>(null);

  function changeGroup(next: string | null) {
    if (props.hike) return;
    setGroupId(next);
    // Guests belong to one group, and the recorder usually attended.
    setUserIds(next ? [props.currentUserId] : []);
    setGuestIds([]);
    if (trail?.option && !isTrailForGroup(trail.option, next)) setTrail(null);
  }

  function chooseTrail(option: TrailOption) {
    setTrail({ ...option, option });
    setChoosingTrail(false);
  }

  /** Why the form can't be sent, as a translation key. The backend checks all of this too. */
  function findProblem(start: Date, durationS: number): string | null {
    if (!trail) return "problems.trailRequired";
    if (Number.isNaN(start.getTime())) return "problems.startRequired";
    if (start.getTime() > Date.now()) return "errors.start_at_in_future";
    if (start.getFullYear() < EARLIEST_YEAR) return "errors.start_at_too_old";
    if (!(durationS > 0)) return "problems.durationRequired";
    if (durationS > MAX_HOURS * SECONDS_PER_HOUR) return "problems.durationTooLong";
    if (groupId && userIds.length === 0 && guestIds.length === 0) {
      return "errors.attendees_required";
    }
    return null;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    // Fields left as they were keep the exact value: the form has no seconds, so going
    // through the inputs would round them away.
    const startChanged = date !== initialDate || time !== initialTime;
    const durationChanged = Number(hours) !== initialHours || Number(minutes) !== initialMinutes;
    const start = hike && !startChanged ? new Date(hike.start_at) : fromLocalInputs(date, time);
    const durationS =
      hike && !durationChanged ? hike.duration_s : toDurationSeconds(hours, minutes);
    const found = findProblem(start, durationS);
    setProblem(found);
    if (found || !trail) return;

    const trimmedNotes = notes.trim() || null;
    if (props.hike === undefined) {
      props.onCreate({
        trail_id: trail.id,
        start_at: toOffsetIso(start),
        duration_s: durationS,
        notes: trimmedNotes,
        group_id: groupId,
        attendee_user_ids: groupId ? userIds : [],
        attendee_guest_ids: groupId ? guestIds : [],
      });
      return;
    }

    const edited = props.hike;
    const update: HikeUpdate = {};
    if (trail.id !== edited.trail.id) update.trail_id = trail.id;
    if (startChanged) update.start_at = toOffsetIso(start);
    if (durationChanged) update.duration_s = durationS;
    if (trimmedNotes !== edited.notes) update.notes = trimmedNotes;
    if (edited.group_id) {
      if (!sameMembers(userIds, initialUserIds)) update.attendee_user_ids = userIds;
      if (!sameMembers(guestIds, initialGuestIds)) update.attendee_guest_ids = guestIds;
    }
    props.onUpdate(update);
  }

  return (
    <form className="form card" onSubmit={submit} noValidate>
      {hike ? (
        <p style={{ margin: 0 }}>
          {hike.group_name ? t("groupHikeOf", { name: hike.group_name }) : t("personalHike")}
        </p>
      ) : (
        <div className="field">
          <label htmlFor="hike-group">{t("hikeType")}</label>
          <select
            id="hike-group"
            value={groupId ?? ""}
            onChange={(event) => changeGroup(event.target.value || null)}
          >
            <option value="">{t("personalHike")}</option>
            {/* A group from the URL stays selectable until the list of groups has loaded. */}
            {groupId && !groups.data?.items.some((group) => group.id === groupId) && (
              <option value={groupId}>{t("selectedGroup")}</option>
            )}
            {groups.data?.items.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
          {groups.isError && <ErrorMessage error={groups.error} ns="hikes" />}
        </div>
      )}

      <div className="field">
        <span style={{ fontWeight: 500 }}>{t("trail")}</span>
        {trail && !choosingTrail ? (
          <div className="actions" style={{ alignItems: "center" }}>
            <span>
              <strong>{trail.name}</strong>{" "}
              <span className="muted">
                {[
                  format.distance(trail.distance_m),
                  ...(trail.elevation_gain_m === null
                    ? []
                    : [format.elevation(trail.elevation_gain_m)]),
                ].join(" · ")}
              </span>{" "}
              {trail.archived && <span className="badge">{t("archived")}</span>}
            </span>
            <button type="button" className="btn" onClick={() => setChoosingTrail(true)}>
              {t("changeTrail")}
            </button>
          </div>
        ) : (
          <>
            <TrailPicker groupId={groupId} onChoose={chooseTrail} />
            {trail && (
              <div>
                <button type="button" className="btn" onClick={() => setChoosingTrail(false)}>
                  {t("keepTrail", { name: trail.name })}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="actions">
        <div className="field" style={{ flex: "1 1 9rem" }}>
          <label htmlFor="hike-date">{t("date")}</label>
          <input
            id="hike-date"
            type="date"
            value={date}
            min={`${EARLIEST_YEAR}-01-01`}
            max={toDateInput(now)}
            required
            onChange={(event) => setDate(event.target.value)}
          />
        </div>
        <div className="field" style={{ flex: "1 1 7rem" }}>
          <label htmlFor="hike-time">{t("startTime")}</label>
          <input
            id="hike-time"
            type="time"
            value={time}
            required
            onChange={(event) => setTime(event.target.value)}
          />
        </div>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t("localTimeHint")}
      </p>

      <div className="actions">
        <div className="field" style={{ flex: "1 1 6rem" }}>
          <label htmlFor="hike-hours">{t("hours")}</label>
          <input
            id="hike-hours"
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_HOURS}
            value={hours}
            onChange={(event) => setHours(event.target.value)}
          />
        </div>
        <div className="field" style={{ flex: "1 1 6rem" }}>
          <label htmlFor="hike-minutes">{t("minutes")}</label>
          <input
            id="hike-minutes"
            type="number"
            inputMode="numeric"
            min={0}
            max={59}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          />
        </div>
      </div>

      {groupId && (
        <AttendeePicker
          groupId={groupId}
          userIds={userIds}
          guestIds={guestIds}
          onUsersChange={setUserIds}
          onGuestsChange={setGuestIds}
          existing={hike?.attendees}
        />
      )}

      <div className="field">
        <label htmlFor="hike-notes">{t("notes")}</label>
        <textarea
          id="hike-notes"
          rows={3}
          maxLength={5000}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>

      {problem && (
        <p className="error" role="alert">
          {t(problem)}
        </p>
      )}
      {!problem && error != null && <ErrorMessage error={error} ns="hikes" />}

      <div className="actions">
        <button className="btn btn-primary" disabled={isPending}>
          {t("common:save")}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t("common:cancel")}
        </button>
      </div>
    </form>
  );
}
