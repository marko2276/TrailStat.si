import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  /** Text of the button that starts the action. */
  label: string;
  /** What will happen, shown before the user commits. */
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
}

/** A dangerous action that asks for confirmation in place, without a browser dialog. */
export function ConfirmAction({ label, children, confirmLabel, onConfirm, pending }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }
  return (
    <div className="confirm" role="group" aria-label={label}>
      <div>{children}</div>
      <div className="actions">
        <button type="button" className="btn btn-danger" disabled={pending} onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}
