import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ErrorMessage } from "../../components/ErrorMessage";
import { Loading } from "../../components/Loading";
import { useMe } from "../profile/api";
import { useCreateHike, useHike, useUpdateHike } from "./api";
import type { Hike } from "./api";
import { HikeForm } from "./HikeForm";

function listPath(groupId: string | null): string {
  return groupId ? `/hikes?group=${groupId}` : "/hikes";
}

export function RecordHikePage() {
  const { t } = useTranslation("hikes");
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialGroupId = params.get("group");
  const { data: me, error } = useMe();
  const createHike = useCreateHike();

  if (error) return <ErrorMessage error={error} ns="hikes" />;
  if (!me) return <Loading />;

  return (
    <>
      <h1>{t("record")}</h1>
      <HikeForm
        currentUserId={me.id}
        initialGroupId={initialGroupId}
        error={createHike.error}
        isPending={createHike.isPending}
        onCancel={() => void navigate(listPath(initialGroupId))}
        onCreate={(hike) =>
          createHike.mutate(hike, {
            onSuccess: (created) => void navigate(listPath(created.group_id)),
          })
        }
      />
    </>
  );
}

function EditForm({ hike }: { hike: Hike }) {
  const navigate = useNavigate();
  const updateHike = useUpdateHike(hike.id);
  const back = listPath(hike.group_id);

  return (
    <HikeForm
      hike={hike}
      error={updateHike.error}
      isPending={updateHike.isPending}
      onCancel={() => void navigate(back)}
      onUpdate={(update) => updateHike.mutate(update, { onSuccess: () => void navigate(back) })}
    />
  );
}

export function EditHikePage() {
  const { t } = useTranslation("hikes");
  const { id = "" } = useParams();
  const { data: hike, error } = useHike(id);

  if (error) return <ErrorMessage error={error} ns="hikes" />;
  if (!hike) return <Loading />;

  return (
    <>
      <h1>{t("editTitle")}</h1>
      {hike.can_edit ? (
        <EditForm key={hike.id} hike={hike} />
      ) : (
        <p className="error" role="alert">
          {t("errors:forbidden")}
        </p>
      )}
    </>
  );
}
