import { useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { useAddGuest, useGroupGuests, useGroupMembers } from "./api";
import type { HikeAttendee } from "./api";

function toggled(ids: string[], id: string, on: boolean): string[] {
  return on ? [...ids, id] : ids.filter((other) => other !== id);
}

function Checkbox({
  label,
  note,
  checked,
  onChange,
}: {
  label: string;
  note?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label style={{ display: "block", padding: "0.25rem 0", fontWeight: 400 }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />{" "}
      {label} {note && <span className="muted">({note})</span>}
    </label>
  );
}

interface Props {
  groupId: string;
  userIds: string[];
  guestIds: string[];
  onUsersChange: (ids: string[]) => void;
  onGuestsChange: (ids: string[]) => void;
  /** Attendees already on the hike, who may have left the group since. */
  existing?: HikeAttendee[];
}

export function AttendeePicker({
  groupId,
  userIds,
  guestIds,
  onUsersChange,
  onGuestsChange,
  existing = [],
}: Props) {
  const { t } = useTranslation("hikes");
  const members = useGroupMembers(groupId);
  const guests = useGroupGuests(groupId);
  const addGuest = useAddGuest(groupId);
  const [nickname, setNickname] = useState("");

  const error = members.error ?? guests.error;
  if (error) return <ErrorMessage error={error} ns="hikes" />;
  if (!members.data || !guests.data) return <Loading />;

  const memberIds = new Set(members.data.items.map((member) => member.user_id));
  const formerMembers = existing.filter(
    (attendee) => attendee.user_id !== null && !memberIds.has(attendee.user_id),
  );
  const guestList = guests.data.items;

  function submitGuest() {
    const name = nickname.trim();
    if (!name) return;
    // Nicknames are unique in a group, so someone typing an existing one means that guest.
    const known = guestList.find(
      (guest) => guest.nickname.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (known) {
      if (!guestIds.includes(known.id)) onGuestsChange([...guestIds, known.id]);
      setNickname("");
      return;
    }
    addGuest.mutate(name, {
      onSuccess: (guest) => {
        onGuestsChange([...guestIds, guest.id]);
        setNickname("");
      },
    });
  }

  function onGuestKeyDown(event: KeyboardEvent) {
    // Enter here adds the guest, it must not submit the whole hike.
    if (event.key === "Enter") {
      event.preventDefault();
      submitGuest();
    }
  }

  return (
    <fieldset className="card" style={{ margin: 0, minWidth: 0 }}>
      <legend>{t("attendees")}</legend>
      {members.data.items.map((member) => (
        <Checkbox
          key={member.user_id}
          label={member.display_name}
          checked={userIds.includes(member.user_id)}
          onChange={(on) => onUsersChange(toggled(userIds, member.user_id, on))}
        />
      ))}
      {formerMembers.map((attendee) => (
        <Checkbox
          key={attendee.user_id}
          label={attendee.name}
          note={t("formerMember")}
          checked={userIds.includes(attendee.user_id!)}
          onChange={(on) => onUsersChange(toggled(userIds, attendee.user_id!, on))}
        />
      ))}
      {guestList.map((guest) => (
        <Checkbox
          key={guest.id}
          label={guest.nickname}
          note={t("guest")}
          checked={guestIds.includes(guest.id)}
          onChange={(on) => onGuestsChange(toggled(guestIds, guest.id, on))}
        />
      ))}
      <div className="field" style={{ marginTop: "0.5rem" }}>
        <label htmlFor="new-guest">{t("newGuest")}</label>
        <div className="actions">
          <input
            id="new-guest"
            value={nickname}
            maxLength={100}
            style={{ flex: "1 1 10rem", minWidth: 0 }}
            onChange={(event) => setNickname(event.target.value)}
            onKeyDown={onGuestKeyDown}
          />
          <button
            type="button"
            className="btn"
            disabled={addGuest.isPending || !nickname.trim()}
            onClick={submitGuest}
          >
            {t("addGuest")}
          </button>
        </div>
        {addGuest.isError && <ErrorMessage error={addGuest.error} ns="hikes" />}
      </div>
    </fieldset>
  );
}
