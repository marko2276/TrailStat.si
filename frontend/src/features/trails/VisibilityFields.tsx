import { useTranslation } from "react-i18next";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { useMyGroups } from "./api";
import type { Sharing, Visibility } from "./api";

export interface SharingValue {
  visibility: Visibility;
  groupId: string;
}

export const DEFAULT_SHARING: SharingValue = { visibility: "private", groupId: "" };

/** What the API expects. The group is only part of it for group visibility. */
export function toSharing({ visibility, groupId }: SharingValue): Sharing {
  return visibility === "group" ? { visibility, group_id: groupId } : { visibility };
}

const OPTIONS: Visibility[] = ["private", "public", "group"];

export function VisibilityFields({
  value,
  onChange,
  groupError,
}: {
  value: SharingValue;
  onChange: (value: SharingValue) => void;
  groupError?: string | null;
}) {
  const { t } = useTranslation("trails");
  const sharedWithGroup = value.visibility === "group";
  const groups = useMyGroups(sharedWithGroup);

  return (
    <>
      <div className="field">
        <label htmlFor="trail-visibility">{t("fields.visibility")}</label>
        <select
          id="trail-visibility"
          value={value.visibility}
          onChange={(event) => onChange({ ...value, visibility: event.target.value as Visibility })}
        >
          {OPTIONS.map((option) => (
            <option key={option} value={option}>
              {t(`visibility.${option}`)}
            </option>
          ))}
        </select>
        <span className="muted">{t(`visibilityHint.${value.visibility}`)}</span>
      </div>
      {sharedWithGroup && (
        <div className="field">
          <label htmlFor="trail-group">{t("fields.group")}</label>
          {groups.isPending && <Loading />}
          {groups.isError && <ErrorMessage error={groups.error} ns="trails" />}
          {groups.data && groups.data.items.length === 0 && (
            <p className="error" role="alert">
              {t("noGroups")}
            </p>
          )}
          {groups.data && groups.data.items.length > 0 && (
            <select
              id="trail-group"
              value={value.groupId}
              onChange={(event) => onChange({ ...value, groupId: event.target.value })}
              aria-invalid={groupError ? true : undefined}
            >
              <option value="">{t("chooseGroup")}</option>
              {groups.data.items.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          )}
          {groupError && (
            <p className="error" role="alert">
              {groupError}
            </p>
          )}
        </div>
      )}
    </>
  );
}
