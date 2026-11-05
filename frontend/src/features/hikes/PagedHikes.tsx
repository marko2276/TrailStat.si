import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { PAGE_SIZE, useHikes } from "./api";
import type { Period } from "./api";
import { HikeList } from "./HikeCard";

interface Props {
  /** A group's hikes, or the signed-in user's own when null. */
  groupId: string | null;
  period?: Period;
  /** Shown when there are no hikes. */
  emptyText: string;
}

/** A list of hikes with paging. Give it a `key` so changing the list returns to the first page. */
export function PagedHikes({ groupId, period = {}, emptyText }: Props) {
  const { t } = useTranslation("hikes");
  const [page, setPage] = useState(0);
  const { data, error } = useHikes(groupId, { ...period, page });

  if (error) return <ErrorMessage error={error} ns="hikes" />;
  if (!data) return <Loading />;

  // Deleting the only hike of the last page leaves that page empty.
  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  if (data.items.length === 0 && page > 0) {
    return (
      <button className="btn" onClick={() => setPage(pages - 1)}>
        {t("common:previous")}
      </button>
    );
  }
  if (data.total === 0) return <p className="muted">{emptyText}</p>;

  return (
    <>
      <p className="muted">{t("count", { count: data.total })}</p>
      <HikeList hikes={data.items} />
      {pages > 1 && (
        <div className="actions" style={{ alignItems: "center", marginTop: "0.75rem" }}>
          <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>
            {t("common:previous")}
          </button>
          <span className="muted">{t("page", { page: page + 1, pages })}</span>
          <button className="btn" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
            {t("common:next")}
          </button>
        </div>
      )}
    </>
  );
}
