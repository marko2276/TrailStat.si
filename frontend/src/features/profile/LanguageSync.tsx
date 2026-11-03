import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useMe, useUpdateMe } from "./api";

/**
 * Keeps the app's language and the profile's language together: a language stored on the
 * profile follows the user to every device. On first sign-in, the language the user
 * already sees is stored.
 */
export function LanguageSync() {
  const { i18n } = useTranslation();
  const { data: me } = useMe();
  const { mutate: updateMe } = useUpdateMe();
  const locale = me?.locale;
  const signedIn = me !== undefined;

  useEffect(() => {
    if (!signedIn) return;
    if (locale === null) {
      updateMe({ locale: i18n.resolvedLanguage ?? "en" });
    } else if (locale && locale !== i18n.resolvedLanguage) {
      void i18n.changeLanguage(locale);
    }
    // Only react to the stored language, so that switching language is not undone.
  }, [locale, signedIn]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
