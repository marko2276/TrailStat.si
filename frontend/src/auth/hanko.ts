import type { Hanko } from "@teamhanko/hanko-elements";

const apiUrl = import.meta.env.VITE_HANKO_API_URL;

export const isHankoConfigured = Boolean(apiUrl);

let instance: Hanko | null = null;
let registration: Promise<Hanko> | null = null;

/** Loads Hanko's components once. They are loaded lazily to keep the first page small. */
export function getHanko(): Promise<Hanko> {
  registration ??= (async () => {
    const [{ register }, { en }] = await Promise.all([
      import("@teamhanko/hanko-elements"),
      import("@teamhanko/hanko-elements/i18n/en"),
    ]);
    // Hanko ships no Slovenian, so more languages come from this folder. English must be passed
    // too: this option replaces the built-in translations, and Hanko would otherwise keep trying
    // to download the missing language.
    const translations = import.meta.glob<Record<string, unknown>>("./hanko-translations/*.json", {
      eager: true,
      import: "default",
    });
    const byLanguage = Object.fromEntries(
      Object.entries(translations).map(([path, content]) => [
        /([^/]+)\.json$/.exec(path)![1],
        content,
      ]),
    );
    const result = await register(apiUrl!, {
      translations: { en, ...byLanguage },
      fallbackLanguage: "en",
    });
    instance = result.hanko;
    return result.hanko;
  })();
  return registration;
}

export function getSessionToken(): string | undefined {
  return instance?.getSessionToken() || undefined;
}
