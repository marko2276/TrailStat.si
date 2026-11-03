import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";

/**
 * Shows an error in the user's language. Looks up the backend's code in `errors` of the given
 * namespace, then in the shared `errors` namespace, then falls back to a generic message.
 */
export function ErrorMessage({ error, ns }: { error: unknown; ns?: string }) {
  const { t, i18n } = useTranslation();
  const code = error instanceof ApiError ? error.code : "generic";
  const keys = [...(ns ? [`${ns}:errors.${code}`] : []), `errors:${code}`];
  const key = keys.find((candidate) => i18n.exists(candidate)) ?? "errors:generic";
  return (
    <p className="error" role="alert">
      {t(key)}
    </p>
  );
}
