import { useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { ConfirmAction } from "./ConfirmAction";
import { useAddGuest, useGuests, useRemoveGuest, useRenameGuest } from "./api";
import type { Group, Guest } from "./api";

function RenameForm({ group, guest, onDone }: { group: Group; guest: Guest; onDone: () => void }) {
  const { t } = useTranslation("groups");
  const rename = useRenameGuest(group.id);
  const [nickname, setNickname] = useState(guest.nickname);

  function submit(event: FormEvent) {
    event.preventDefault();
    rename.mutate({ guestId: guest.id, nickname }, { onSuccess: onDone });
  }

  return (
    <form className="form" onSubmit={submit}>
      <div className="field">
        <label htmlFor={`rename-${guest.id}`}>{t("guests.nickname")}</label>
        <input
          id={`rename-${guest.id}`}
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          required
          maxLength={100}
        />
      </div>
      {rename.isError && <ErrorMessage error={rename.error} ns="groups" />}
      <div className="actions">
        <button className="btn btn-primary" disabled={rename.isPending}>
          {t("common:save")}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          {t("common:cancel")}
        </button>
      </div>
    </form>
  );
}

function GuestRow({ group, guest }: { group: Group; guest: Guest }) {
  const { t } = useTranslation("groups");
  const remove = useRemoveGuest(group.id);
  const [renaming, setRenaming] = useState(false);

  if (renaming) {
    return (
      <li className="card">
        <RenameForm group={group} guest={guest} onDone={() => setRenaming(false)} />
      </li>
    );
  }
  return (
    <li className="card">
      <div>{guest.nickname}</div>
      {group.is_admin && (
        <div className="actions row-actions">
          <button type="button" className="btn" onClick={() => setRenaming(true)}>
            {t("guests.rename")}
          </button>
          <ConfirmAction
            label={t("guests.remove")}
            confirmLabel={t("guests.removeConfirm")}
            pending={remove.isPending}
            onConfirm={() => remove.mutate(guest.id)}
          >
            <p>{t("guests.removeWarning", { name: guest.nickname })}</p>
          </ConfirmAction>
        </div>
      )}
      {remove.isError && <ErrorMessage error={remove.error} ns="groups" />}
    </li>
  );
}

export function GuestsSection({ group }: { group: Group }) {
  const { t } = useTranslation("groups");
  const { data, error } = useGuests(group.id);
  const add = useAddGuest(group.id);
  const [nickname, setNickname] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    add.mutate(nickname, { onSuccess: () => setNickname("") });
  }

  return (
    <section aria-labelledby="group-guests">
      <h2 id="group-guests">{t("guests.title")}</h2>
      <p className="muted">{t("guests.hint")}</p>
      {error && <ErrorMessage error={error} ns="groups" />}
      {!error && !data && <Loading />}
      {data && data.items.length === 0 && <p className="muted">{t("guests.empty")}</p>}
      {data && data.items.length > 0 && (
        <ul className="plain-list">
          {data.items.map((guest) => (
            <GuestRow key={guest.id} group={group} guest={guest} />
          ))}
        </ul>
      )}
      <form className="form section-form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="new-guest">{t("guests.add")}</label>
          <input
            id="new-guest"
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            required
            maxLength={100}
          />
        </div>
        {add.isError && <ErrorMessage error={add.error} ns="groups" />}
        <div>
          <button className="btn" disabled={add.isPending}>
            {t("guests.addButton")}
          </button>
        </div>
      </form>
    </section>
  );
}
