import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { GroupInput, GroupVisibility } from "./api";

interface Props {
  initial?: GroupInput;
  submitLabel: string;
  pending: boolean;
  onSubmit: (input: GroupInput) => void;
  /** Shown above the submit button, e.g. an error. */
  children?: ReactNode;
}

export function GroupForm({ initial, submitLabel, pending, onSubmit, children }: Props) {
  const { t } = useTranslation("groups");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [visibility, setVisibility] = useState<GroupVisibility>(initial?.visibility ?? "private");

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({ name, description: description.trim() || null, visibility });
  }

  return (
    <form className="form card" onSubmit={submit}>
      <div className="field">
        <label htmlFor="group-name">{t("form.name")}</label>
        <input
          id="group-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={100}
        />
      </div>
      <div className="field">
        <label htmlFor="group-description">{t("form.description")}</label>
        <textarea
          id="group-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          maxLength={2000}
        />
      </div>
      <div className="field">
        <label htmlFor="group-visibility">{t("form.visibility")}</label>
        <select
          id="group-visibility"
          value={visibility}
          onChange={(event) => setVisibility(event.target.value as GroupVisibility)}
        >
          <option value="private">{t("visibility.private")}</option>
          <option value="public">{t("visibility.public")}</option>
        </select>
        <p className="muted">{t(`form.visibilityHint.${visibility}`)}</p>
      </div>
      {children}
      <div>
        <button className="btn btn-primary" disabled={pending}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
