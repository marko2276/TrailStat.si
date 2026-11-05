import { useTranslation } from "react-i18next";
import i18nInstance, { languageName, supportedLanguages } from "../../i18n";
import { useAuth } from "../../auth/AuthContext";
import { useUpdateMe } from "./api";

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const { status } = useAuth();
  const updateMe = useUpdateMe();

  async function change(language: string) {
    await i18nInstance.changeLanguage(language);
    if (status === "authenticated") updateMe.mutate({ locale: language });
  }

  return (
    <select
      className="language-switcher"
      aria-label={t("language")}
      value={i18n.resolvedLanguage}
      onChange={(event) => void change(event.target.value)}
    >
      {supportedLanguages.map((language) => (
        <option key={language} value={language}>
          {languageName(language)}
        </option>
      ))}
    </select>
  );
}
