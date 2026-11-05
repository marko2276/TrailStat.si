import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { MemberView } from "./MemberView";
import { NonMemberView } from "./NonMemberView";
import { useGroup } from "./api";

export function GroupDetailPage() {
  const { t } = useTranslation("groups");
  const { id = "" } = useParams();
  const { data: group, error } = useGroup(id);

  return (
    <>
      <p>
        <Link to="/groups">{t("backToGroups")}</Link>
      </p>
      {error && <ErrorMessage error={error} ns="groups" />}
      {!error && !group && <Loading />}
      {group &&
        (group.is_member ? (
          <MemberView key={group.id} group={group} />
        ) : (
          <NonMemberView key={group.id} group={group} />
        ))}
    </>
  );
}
