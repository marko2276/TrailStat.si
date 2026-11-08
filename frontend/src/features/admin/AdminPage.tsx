import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { languageName } from "../../i18n";
import { useFormat } from "../../lib/format";
import { useMe } from "../profile/api";
import { useAdminStats } from "./api";
import type { AdminStats } from "./api";

const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;

/** 1536 → "1.5 kB", in the user's language. */
export function formatBytes(bytes: number, locale: string): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}

/** Totals for the people who run TrailStat.si. Read-only. */
export function AdminPage() {
  const { t } = useTranslation("admin");
  const me = useMe();
  // Others get a 404 from the server; this only avoids asking for nothing.
  const stats = useAdminStats();

  if (me.data && !me.data.is_admin) return <p>{t("common:notFound")}</p>;
  if (stats.isPending) return <Loading />;
  if (stats.isError) return <ErrorMessage error={stats.error} />;

  return (
    <article className="admin">
      <h1>{t("title")}</h1>
      <Users users={stats.data.users} />
      <Content content={stats.data.content} />
      <Database database={stats.data.database} />
      <Server server={stats.data.server} />
    </article>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Figures({ items }: { items: [label: string, value: ReactNode][] }) {
  return (
    <dl className="stat-grid">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="muted">{label}</dt>
          <dd className="stat-value">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "label: count" pairs on one line, largest first. */
function Breakdown({
  label,
  counts,
  name,
}: {
  label: string;
  counts: Record<string, number>;
  name: (key: string) => string;
}) {
  const format = useFormat();
  const entries = Object.entries(counts).sort(([, a], [, b]) => b - a);
  return (
    <p>
      <span className="muted">{label}: </span>
      {entries.length === 0
        ? "–"
        : entries.map(([key, count]) => `${name(key)} ${format.number(count)}`).join(" · ")}
    </p>
  );
}

function Users({ users }: { users: AdminStats["users"] }) {
  const { t } = useTranslation("admin");
  const format = useFormat();
  return (
    <Section title={t("users.title")}>
      <Figures
        items={[
          [t("users.total"), format.number(users.total)],
          [t("users.new7"), format.number(users.new_7_days)],
          [t("users.new30"), format.number(users.new_30_days)],
          [t("users.active30"), format.number(users.active_30_days)],
        ]}
      />
      <Breakdown
        label={t("users.byLanguage")}
        counts={users.by_language}
        name={(code) => (code === "unknown" ? t("unknown") : languageName(code))}
      />
    </Section>
  );
}

function Content({ content }: { content: AdminStats["content"] }) {
  const { t } = useTranslation("admin");
  const format = useFormat();
  return (
    <Section title={t("content.title")}>
      <Figures
        items={[
          [t("content.trails"), format.number(content.trails)],
          [t("content.archived"), format.number(content.trails_archived)],
          [t("content.hikes"), format.number(content.hikes)],
          [t("content.hikes30"), format.number(content.hikes_30_days)],
          [t("content.groups"), format.number(content.groups)],
          [t("content.memberships"), format.number(content.memberships)],
          [t("content.guests"), format.number(content.guests)],
          [t("content.invitations"), format.number(content.pending_invitations)],
          [t("content.joinRequests"), format.number(content.pending_join_requests)],
        ]}
      />
      <Breakdown
        label={t("content.bySource")}
        counts={content.trails_by_source}
        name={(key) => t(`sources.${key}`, { defaultValue: key })}
      />
      <Breakdown
        label={t("content.byVisibility")}
        counts={content.trails_by_visibility}
        name={(key) => t(`visibility.${key}`, { defaultValue: key })}
      />
    </Section>
  );
}

function Database({ database }: { database: AdminStats["database"] }) {
  const { t, i18n } = useTranslation("admin");
  const format = useFormat();
  const locale = i18n.resolvedLanguage ?? "en";
  return (
    <Section title={t("database.title")}>
      <Figures
        items={[
          [t("database.size"), formatBytes(database.size_bytes, locale)],
          [t("database.migration"), database.migration ?? "–"],
        ]}
      />
      <div className="table-wrap">
        <table>
          <caption className="muted">{t("database.largestTables")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("database.table")}</th>
              <th scope="col">{t("database.tableSize")}</th>
              <th scope="col">{t("database.rows")}</th>
            </tr>
          </thead>
          <tbody>
            {database.largest_tables.map((table) => (
              <tr key={table.name}>
                <td>{table.name}</td>
                <td>{formatBytes(table.size_bytes, locale)}</td>
                <td>{format.number(table.rows_estimate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function Server({ server }: { server: AdminStats["server"] }) {
  const { t, i18n } = useTranslation("admin");
  const format = useFormat();
  const locale = i18n.resolvedLanguage ?? "en";
  const yesNo = (value: boolean) => (value ? t("yes") : t("no"));
  return (
    <Section title={t("server.title")}>
      <Figures
        items={[
          [t("server.version"), server.version],
          [t("server.environment"), server.environment],
          [t("server.startedAt"), format.dateTime(server.started_at)],
          [
            t("server.elevationData"),
            t("server.tiles", {
              count: server.elevation_data.tiles,
              size: formatBytes(server.elevation_data.size_bytes, locale),
            }),
          ],
          [t("server.email"), yesNo(server.email_configured)],
          [t("server.bankTransfer"), yesNo(server.donations_bank_transfer)],
          [t("server.flik"), yesNo(server.donations_flik)],
        ]}
      />
    </Section>
  );
}
