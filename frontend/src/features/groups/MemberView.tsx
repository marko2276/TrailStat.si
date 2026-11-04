import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { ErrorMessage } from "../../components/ErrorMessage";
import { ConfirmAction } from "./ConfirmAction";
import { GroupActivity } from "./GroupActivity";
import { GroupForm } from "./GroupForm";
import { GuestsSection } from "./GuestsSection";
import { InvitationsSection } from "./InvitationsSection";
import { JoinRequestsSection } from "./JoinRequestsSection";
import { MembersSection } from "./MembersSection";
import { useDeleteGroup, useLeaveGroup, useUpdateGroup } from "./api";
import type { Group } from "./api";

function SettingsSection({ group, onDone }: { group: Group; onDone: () => void }) {
  const { t } = useTranslation("groups");
  const update = useUpdateGroup(group.id);

  return (
    <section aria-labelledby="group-settings">
      <h2 id="group-settings">{t("settings")}</h2>
      <GroupForm
        initial={group}
        submitLabel={t("common:save")}
        pending={update.isPending}
        onSubmit={(input) => update.mutate(input, { onSuccess: onDone })}
      >
        {update.isError && <ErrorMessage error={update.error} ns="groups" />}
      </GroupForm>
    </section>
  );
}

function LeaveOrDelete({ group }: { group: Group }) {
  const { t } = useTranslation("groups");
  const navigate = useNavigate();
  const leave = useLeaveGroup(group.id);
  const remove = useDeleteGroup(group.id);
  const backToList = { onSuccess: () => void navigate("/groups", { replace: true }) };

  return (
    <section aria-labelledby="group-danger">
      <h2 id="group-danger">{t("danger.title")}</h2>
      <div className="actions">
        <ConfirmAction
          label={t("danger.leave")}
          confirmLabel={t("danger.leaveConfirm")}
          pending={leave.isPending}
          onConfirm={() => leave.mutate(undefined, backToList)}
        >
          <p>
            {group.visibility === "public"
              ? t("danger.leaveWarningPublic")
              : t("danger.leaveWarningPrivate")}
          </p>
        </ConfirmAction>
        {group.is_admin && (
          <ConfirmAction
            label={t("danger.delete")}
            confirmLabel={t("danger.deleteConfirm")}
            pending={remove.isPending}
            onConfirm={() => remove.mutate(undefined, backToList)}
          >
            <p>{t("danger.deleteIntro", { name: group.name })}</p>
            <ul>
              <li>{t("danger.deleteHikes")}</li>
              <li>{t("danger.deleteGuests")}</li>
              <li>{t("danger.deleteTrails")}</li>
              <li>{t("danger.deleteMembers")}</li>
            </ul>
            <p>{t("danger.deleteFinal")}</p>
          </ConfirmAction>
        )}
      </div>
      {leave.isError && <ErrorMessage error={leave.error} ns="groups" />}
      {remove.isError && <ErrorMessage error={remove.error} ns="groups" />}
    </section>
  );
}

export function MemberView({ group }: { group: Group }) {
  const { t } = useTranslation("groups");
  const [editing, setEditing] = useState(false);

  return (
    <>
      <div className="page-header">
        <h1>{group.name}</h1>
        {group.is_admin && !editing && (
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            {t("common:edit")}
          </button>
        )}
      </div>
      <div className="actions">
        <span className="badge">{t(`visibility.${group.visibility}`)}</span>
        {group.is_admin && <span className="badge">{t("role.admin")}</span>}
        <span className="badge">{t("memberCount", { count: group.member_count ?? 0 })}</span>
      </div>
      {group.description && <p>{group.description}</p>}

      {group.is_admin && editing && (
        <SettingsSection group={group} onDone={() => setEditing(false)} />
      )}
      <GroupActivity groupId={group.id} />
      <MembersSection group={group} />
      {group.is_admin && <JoinRequestsSection groupId={group.id} />}
      {group.is_admin && <InvitationsSection groupId={group.id} />}
      <GuestsSection group={group} />
      <LeaveOrDelete group={group} />
    </>
  );
}
