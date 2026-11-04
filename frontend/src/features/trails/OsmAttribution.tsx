import { useTranslation } from "react-i18next";

/** ODbL requires crediting OpenStreetMap wherever its data is shown. */
export function OsmAttribution({ relationId }: { relationId?: number | null }) {
  const { t } = useTranslation("trails");
  return (
    <p className="attribution muted">
      {t("osmAttribution")}{" "}
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
        © OpenStreetMap contributors (ODbL)
      </a>
      {relationId != null && (
        <>
          {" · "}
          <a
            href={`https://www.openstreetmap.org/relation/${relationId}`}
            target="_blank"
            rel="noreferrer"
          >
            {t("viewOnOsm")}
          </a>
        </>
      )}
    </p>
  );
}
