import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

// Every src/locales/<language>/<namespace>.json is picked up automatically,
// so adding a language or a namespace needs no code change.
const modules = import.meta.glob<Record<string, unknown>>("../locales/*/*.json", {
  eager: true,
  import: "default",
});

const resources: Record<string, Record<string, Record<string, unknown>>> = {};
for (const [path, content] of Object.entries(modules)) {
  const match = /locales\/([^/]+)\/([^/]+)\.json$/.exec(path);
  if (match) {
    const [, language, namespace] = match;
    (resources[language] ??= {})[namespace] = content;
  }
}

export const supportedLanguages = Object.keys(resources).sort();

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    supportedLngs: supportedLanguages,
    fallbackLng: "en",
    load: "languageOnly",
    defaultNS: "common",
    ns: Object.keys(resources.en),
    interpolation: { escapeValue: false }, // React already escapes
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "trailstat.language",
    },
  });

function updateDocumentLanguage(language: string) {
  document.documentElement.lang = language;
}
updateDocumentLanguage(i18n.resolvedLanguage ?? "en");
i18n.on("languageChanged", updateDocumentLanguage);

/** A language's name in that language, e.g. "slovenščina". */
export function languageName(language: string): string {
  const name = new Intl.DisplayNames([language], { type: "language" }).of(language) ?? language;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export default i18n;
