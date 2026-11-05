import { useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { GROUPS_PAGE_SIZE, useGroups } from "./api";
import type { Group, GroupScope } from "./api";

function GroupRow({ group }: { group: Group }) {
  const { t } = useTranslation("groups");
  return (
    <li className="card list-row">
      <Link to={`/groups/${group.id}`}>{group.name}</Link>
      <span className="actions">
        {group.is_admin && <span className="badge">{t("role.admin")}</span>}
        {group.is_member && !group.is_admin && <span className="badge">{t("role.member")}</span>}
        <span className="badge">{t(`visibility.${group.visibility}`)}</span>
      </span>
    </li>
  );
}

function GroupList({ scope, q, empty }: { scope: GroupScope; q: string; empty: string }) {
  const { t } = useTranslation();
  const [offset, setOffset] = useState(0);
  // A new search starts from the first page.
  const [lastQ, setLastQ] = useState(q);
  if (q !== lastQ) {
    setLastQ(q);
    setOffset(0);
  }
  const { data, error } = useGroups(scope, q, offset);

  if (error) return <ErrorMessage error={error} ns="groups" />;
  if (!data) return <Loading />;
  if (data.items.length === 0) return <p className="muted">{empty}</p>;

  return (
    <>
      <ul className="plain-list">
        {data.items.map((group) => (
          <GroupRow key={group.id} group={group} />
        ))}
      </ul>
      {data.total > GROUPS_PAGE_SIZE && (
        <div className="actions pager">
          <button
            type="button"
            className="btn"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - GROUPS_PAGE_SIZE))}
          >
            {t("previous")}
          </button>
          <button
            type="button"
            className="btn"
            disabled={offset + GROUPS_PAGE_SIZE >= data.total}
            onClick={() => setOffset(offset + GROUPS_PAGE_SIZE)}
          >
            {t("next")}
          </button>
        </div>
      )}
    </>
  );
}

export function GroupsPage() {
  const { t } = useTranslation("groups");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    setQ(search.trim());
  }

  return (
    <>
      <div className="page-header">
        <h1>{t("title")}</h1>
        <Link className="btn btn-primary" to="/groups/new">
          {t("create")}
        </Link>
      </div>

      <h2>{t("mine")}</h2>
      <GroupList scope="mine" q="" empty={t("mineEmpty")} />

      <h2>{t("public")}</h2>
      <form className="search-form" role="search" onSubmit={submit}>
        <input
          type="search"
          aria-label={t("searchLabel")}
          placeholder={t("searchLabel")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button className="btn">{t("search")}</button>
      </form>
      <GroupList scope="public" q={q} empty={q ? t("publicNoMatch") : t("publicEmpty")} />
    </>
  );
}
