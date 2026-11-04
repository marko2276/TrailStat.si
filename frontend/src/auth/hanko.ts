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

let lastToken: string | undefined;

export function getSessionToken(): string | undefined {
  const token = instance?.getSessionToken() || undefined;
  if (token) lastToken = token;
  return token;
}

/** Hanko removes the token when it deletes the user, but it stays valid until it expires. */
export function getLastSessionToken(): string | undefined {
  return getSessionToken() ?? lastToken;
}

/**
 * Deletes the login at Hanko. Returns false when that is not possible, for example because
 * account deletion is turned off in the Hanko project: only Hanko can delete it then.
 */
export async function deleteHankoAccount(): Promise<boolean> {
  try {
    const hanko = await getHanko();
    const state = await hanko.createState("profile", {
      dispatchAfterStateChangeEvent: false,
      loadFromCache: false,
    });
    const action = (
      state.actions as { account_delete?: { enabled?: boolean; run(): Promise<{ name: string }> } }
    ).account_delete;
    if (!action || action.enabled === false) return false;
    return (await action.run()).name === "account_deleted";
  } catch {
    return false;
  }
}
