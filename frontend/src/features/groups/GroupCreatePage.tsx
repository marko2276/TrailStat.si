import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { ErrorMessage } from "../../components/ErrorMessage";
import { GroupForm } from "./GroupForm";
import { useCreateGroup } from "./api";

export function GroupCreatePage() {
  const { t } = useTranslation("groups");
  const navigate = useNavigate();
  const createGroup = useCreateGroup();

  return (
    <>
      <h1>{t("create")}</h1>
      <GroupForm
        submitLabel={t("create")}
        pending={createGroup.isPending}
        onSubmit={(input) =>
          createGroup.mutate(input, {
            onSuccess: (group) => void navigate(`/groups/${group.id}`, { replace: true }),
          })
        }
      >
        {createGroup.isError && <ErrorMessage error={createGroup.error} ns="groups" />}
      </GroupForm>
    </>
  );
}
