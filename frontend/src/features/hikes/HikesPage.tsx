import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { ErrorMessage } from "../../components/ErrorMessage";
import { useGroup } from "./api";
import { PagedHikes } from "./PagedHikes";

function GroupHikes({ groupId }: { groupId: string }) {
  const { t } = useTranslation("hikes");
  const { data: group, error } = useGroup(groupId);

  if (error) return <ErrorMessage error={error} ns="hikes" />;
  return (
    <>
      <div className="page-header">
        <h1>{group ? t("groupTitle", { name: group.name }) : t("title")}</h1>
        <div className="actions">
          <Link className="btn" to="/hikes">
            {t("myHikes")}
          </Link>
          {group?.is_member && (
            <Link className="btn btn-primary" to={`/hikes/new?group=${groupId}`}>
              {t("record")}
            </Link>
          )}
        </div>
      </div>
      <PagedHikes key={groupId} groupId={groupId} emptyText={t("emptyGroup")} />
    </>
  );
}

export function HikesPage() {
  const { t } = useTranslation("hikes");
  const [params] = useSearchParams();
  const groupId = params.get("group");

  if (groupId) return <GroupHikes groupId={groupId} />;
  return (
    <>
      <div className="page-header">
        <h1>{t("myHikes")}</h1>
        <Link className="btn btn-primary" to="/hikes/new">
          {t("record")}
        </Link>
      </div>
      <PagedHikes groupId={null} emptyText={t("emptyMine")} />
    </>
  );
}
