import { useTranslation } from "react-i18next";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { useMe } from "../profile/api";
import { ConfirmAction } from "./ConfirmAction";
import { useMembers, useRemoveMember, useSetMemberRole } from "./api";
import type { Group, Member } from "./api";

function MemberRow({ group, member, isMe }: { group: Group; member: Member; isMe: boolean }) {
  const { t } = useTranslation("groups");
  const setRole = useSetMemberRole(group.id);
  const remove = useRemoveMember(group.id);
  const error = setRole.error ?? remove.error;

  return (
    <li className="card">
      <div className="list-row">
        <span>
          {member.display_name} {isMe && <span className="muted">{t("members.you")}</span>}
        </span>
        <span className="badge">{t(`role.${member.role}`)}</span>
      </div>
      {group.is_admin && (
        <div className="actions row-actions">
          {member.role === "member" ? (
            <button
              type="button"
              className="btn"
              disabled={setRole.isPending}
              onClick={() => setRole.mutate({ userId: member.user_id, role: "admin" })}
            >
              {t("members.promote")}
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={setRole.isPending}
              onClick={() => setRole.mutate({ userId: member.user_id, role: "member" })}
            >
              {t("members.demote")}
            </button>
          )}
          {!isMe && (
            <ConfirmAction
              label={t("members.remove")}
              confirmLabel={t("members.removeConfirm")}
              pending={remove.isPending}
              onConfirm={() => remove.mutate(member.user_id)}
            >
              <p>{t("members.removeWarning", { name: member.display_name })}</p>
            </ConfirmAction>
          )}
        </div>
      )}
      {error && <ErrorMessage error={error} ns="groups" />}
    </li>
  );
}

export function MembersSection({ group }: { group: Group }) {
  const { t } = useTranslation("groups");
  const { data, error } = useMembers(group.id);
  const { data: me } = useMe();

  return (
    <section aria-labelledby="group-members">
      <h2 id="group-members">{t("members.title")}</h2>
      {error && <ErrorMessage error={error} ns="groups" />}
      {!error && !data && <Loading />}
      {data && (
        <ul className="plain-list">
          {data.items.map((member) => (
            <MemberRow
              key={member.user_id}
              group={group}
              member={member}
              isMe={member.user_id === me?.id}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
