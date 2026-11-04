import { useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { useCreateTrail, useTrail, useUpdateTrail } from "./api";
import type { TrailDetail, TrailUpdate } from "./api";
import { DEFAULT_SHARING, toSharing, VisibilityFields } from "./VisibilityFields";
import type { SharingValue } from "./VisibilityFields";

// The same limits as the backend's.
const MAX_NAME = 200;
const MAX_DESCRIPTION = 5000;
const MAX_DISTANCE_KM = 10000;
const MAX_GAIN_M = 1000000;
const MIN_HEIGHT_M = -500;
const MAX_HEIGHT_M = 9000;

/** Accepts a decimal comma, which is what a Slovenian keyboard or habit produces. NaN if invalid. */
function parseNumber(text: string): number {
  const normal = text.trim().replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(normal) ? Number(normal) : NaN;
}

function isWhole(value: number) {
  return Number.isInteger(value);
}

interface Values {
  name: string;
  description: string;
  distanceKm: string;
  gain: string;
  highest: string;
  sharing: SharingValue;
}

type FieldErrors = Partial<Record<"name" | "distance" | "gain" | "highest" | "group", string>>;

function TrailForm({
  initial,
  measurementsEditable,
  submitLabel,
  pending,
  error,
  cancelTo,
  onSubmit,
}: {
  initial: Values;
  measurementsEditable: boolean;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  cancelTo: string;
  onSubmit: (values: Values) => void;
}) {
  const { t } = useTranslation("trails");
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<FieldErrors>({});

  function set<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function validate(): FieldErrors {
    const found: FieldErrors = {};
    if (!values.name.trim()) found.name = t("validation.name");
    if (values.sharing.visibility === "group" && !values.sharing.groupId) {
      found.group = t("validation.group");
    }
    if (measurementsEditable) {
      const km = parseNumber(values.distanceKm);
      // Below half a metre rounds to nothing.
      if (!(km * 1000 >= 0.5 && km <= MAX_DISTANCE_KM)) found.distance = t("validation.distance");
      const gain = parseNumber(values.gain);
      if (!(isWhole(gain) && gain >= 0 && gain <= MAX_GAIN_M)) found.gain = t("validation.gain");
      if (values.highest.trim()) {
        const highest = parseNumber(values.highest);
        if (!(isWhole(highest) && highest >= MIN_HEIGHT_M && highest <= MAX_HEIGHT_M)) {
          found.highest = t("validation.highest");
        }
      }
    }
    return found;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length === 0) onSubmit(values);
  }

  function fieldError(key: keyof FieldErrors) {
    return errors[key] ? (
      <p className="error" role="alert">
        {errors[key]}
      </p>
    ) : null;
  }

  return (
    <form className="form card" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="trail-name">{t("fields.name")}</label>
        <input
          id="trail-name"
          value={values.name}
          onChange={(event) => set("name", event.target.value)}
          maxLength={MAX_NAME}
          aria-invalid={errors.name ? true : undefined}
        />
        {fieldError("name")}
      </div>
      {measurementsEditable && (
        <>
          <div className="field">
            <label htmlFor="trail-distance">{t("fields.distanceKm")}</label>
            <input
              id="trail-distance"
              inputMode="decimal"
              value={values.distanceKm}
              onChange={(event) => set("distanceKm", event.target.value)}
              aria-invalid={errors.distance ? true : undefined}
            />
            {fieldError("distance")}
          </div>
          <div className="field">
            <label htmlFor="trail-gain">{t("fields.gainM")}</label>
            <input
              id="trail-gain"
              inputMode="numeric"
              value={values.gain}
              onChange={(event) => set("gain", event.target.value)}
              aria-invalid={errors.gain ? true : undefined}
            />
            {fieldError("gain")}
          </div>
          <div className="field">
            <label htmlFor="trail-highest">{t("fields.highestM")}</label>
            <input
              id="trail-highest"
              inputMode="numeric"
              value={values.highest}
              onChange={(event) => set("highest", event.target.value)}
              aria-invalid={errors.highest ? true : undefined}
            />
            {fieldError("highest")}
          </div>
        </>
      )}
      <div className="field">
        <label htmlFor="trail-description">{t("fields.description")}</label>
        <textarea
          id="trail-description"
          rows={4}
          value={values.description}
          onChange={(event) => set("description", event.target.value)}
          maxLength={MAX_DESCRIPTION}
        />
      </div>
      <VisibilityFields
        value={values.sharing}
        onChange={(sharing) => set("sharing", sharing)}
        groupError={errors.group}
      />
      {error != null && <ErrorMessage error={error} ns="trails" />}
      <div className="actions">
        <button className="btn btn-primary" disabled={pending}>
          {submitLabel}
        </button>
        <Link className="btn" to={cancelTo}>
          {t("common:cancel")}
        </Link>
      </div>
    </form>
  );
}

function measurementsFrom(values: Values) {
  return {
    distance_m: Math.round(parseNumber(values.distanceKm) * 1000),
    elevation_gain_m: parseNumber(values.gain),
    highest_point_m: values.highest.trim() ? parseNumber(values.highest) : null,
  };
}

export function NewTrailPage() {
  const { t } = useTranslation("trails");
  const navigate = useNavigate();
  const create = useCreateTrail();

  return (
    <>
      <h1>{t("new.title")}</h1>
      <TrailForm
        initial={{
          name: "",
          description: "",
          distanceKm: "",
          gain: "",
          highest: "",
          sharing: DEFAULT_SHARING,
        }}
        measurementsEditable
        submitLabel={t("new.submit")}
        pending={create.isPending}
        error={create.error}
        cancelTo="/trails"
        onSubmit={(values) =>
          create.mutate(
            {
              name: values.name.trim(),
              description: values.description.trim() || null,
              ...measurementsFrom(values),
              ...toSharing(values.sharing),
            },
            { onSuccess: (trail) => void navigate(`/trails/${trail.id}`) },
          )
        }
      />
    </>
  );
}

function EditForm({ trail }: { trail: TrailDetail }) {
  const { t } = useTranslation("trails");
  const navigate = useNavigate();
  const update = useUpdateTrail(trail.id);
  const manual = trail.source === "manual";

  return (
    <TrailForm
      initial={{
        name: trail.name,
        description: trail.description ?? "",
        distanceKm: String(trail.distance_m / 1000),
        gain: String(trail.elevation_gain_m ?? ""),
        highest: String(trail.highest_point_m ?? ""),
        sharing: { visibility: trail.visibility, groupId: trail.group_id ?? "" },
      }}
      measurementsEditable={manual}
      submitLabel={t("common:save")}
      pending={update.isPending}
      error={update.error}
      cancelTo={`/trails/${trail.id}`}
      onSubmit={(values) => {
        const changes: TrailUpdate = {
          name: values.name.trim(),
          description: values.description.trim() || null,
          ...(manual ? measurementsFrom(values) : {}),
          ...toSharing(values.sharing),
        };
        update.mutate(changes, {
          onSuccess: () => void navigate(`/trails/${trail.id}`),
        });
      }}
    />
  );
}

export function EditTrailPage() {
  const { t } = useTranslation("trails");
  const { id } = useParams();
  const { data: trail, error } = useTrail(id!);

  if (error) return <ErrorMessage error={error} ns="trails" />;
  if (!trail) return <Loading />;

  return (
    <>
      <h1>{t("edit.title")}</h1>
      {trail.can_edit ? (
        <EditForm key={trail.id} trail={trail} />
      ) : (
        <p className="error" role="alert">
          {t("errors:forbidden")}
        </p>
      )}
    </>
  );
}
