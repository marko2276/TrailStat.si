import { useTranslation } from "react-i18next";

const SECTIONS = ["controller", "data", "why", "sharing", "where", "keep", "rights"] as const;

export function PrivacyPage() {
  const { t } = useTranslation("privacy");
  return (
    <article>
      <h1>{t("title")}</h1>
      {SECTIONS.map((section) => (
        <section key={section}>
          <h2>{t(`${section}.title`)}</h2>
          <p>{t(`${section}.text`)}</p>
        </section>
      ))}
    </article>
  );
}
