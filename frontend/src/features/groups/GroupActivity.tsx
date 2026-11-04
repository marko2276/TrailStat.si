import { useTranslation } from "react-i18next";
import { Link } from "react-router";

/**
 * Where a group's hikes and statistics appear. For now it links to the pages of those features;
 * it can show their components once src/features/hikes and src/features/stats export them.
 */
export function GroupActivity({ groupId }: { groupId: string }) {
  const { t } = useTranslation("groups");
  return (
    <section aria-labelledby="group-activity">
      <h2 id="group-activity">{t("activity.title")}</h2>
      <div className="actions">
        <Link className="btn" to={`/hikes?group=${groupId}`}>
          {t("activity.hikes")}
        </Link>
        <Link className="btn" to={`/stats?group=${groupId}`}>
          {t("activity.stats")}
        </Link>
      </div>
    </section>
  );
}
