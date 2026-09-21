import { useState } from "react";
import { useSidecar } from "../lib/SidecarProvider";
import { postJson } from "../lib/sidecar";
import { useI18n } from "../lib/i18n";

/**
 * The plan/apply confirmation flow (trellis-gui tasks.md 7.1, design.md
 * Decision 4): opening this modal calls `POST /plan/<operation>` and
 * shows the real plan; "Apply" only becomes clickable once that plan has
 * been fetched successfully in THIS modal session, and calls
 * `POST /apply/<operation>` with the plan's own id. Cancelling never
 * calls `/apply` — there is no code path from "Cancel" to a network
 * request at all, not just a disabled button.
 */
export interface ConfirmModalProps {
  operation: string;
  title: string;
  /** Extra body fields merged into both the `/plan` and `/apply` request
   * bodies (e.g. `{name, raw}` for mcp-add) — see `planApply.ts`'s routes
   * for what each operation expects. */
  requestBody?: Record<string, unknown>;
  onClose: () => void;
  onApplied: (result: unknown) => void;
}

type Phase = "loading-plan" | "plan-ready" | "applying" | "error";

export function ConfirmModal({ operation, title, requestBody, onClose, onApplied }: ConfirmModalProps) {
  const { port } = useSidecar();
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("loading-plan");
  const [plan, setPlan] = useState<unknown>(undefined);
  const [planId, setPlanId] = useState<string>();
  const [error, setError] = useState<string>();

  if (port !== undefined && phase === "loading-plan" && plan === undefined && error === undefined) {
    // Fired once per mount via the phase/plan/error guard above rather
    // than a useEffect — a modal is created fresh per confirm action, so
    // "on mount" and "on open" are the same event here.
    postJson<{ planId: string; plan: unknown }>(port, `/plan/${operation}`, requestBody ?? {})
      .then((res) => {
        setPlan(res.plan);
        setPlanId(res.planId);
        setPhase("plan-ready");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      });
  }

  async function apply() {
    if (port === undefined || planId === undefined) return;
    setPhase("applying");
    try {
      const res = await postJson<{ result: unknown }>(port, `/apply/${operation}`, { ...requestBody, planId });
      onApplied(res.result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {phase === "loading-plan" && <p className="subtitle">{t("confirmModal.computingPlan")}</p>}
        {error && <div className="error-banner">{error}</div>}
        {plan !== undefined && <pre>{JSON.stringify(plan, null, 2)}</pre>}
        <div className="modal-actions">
          <button onClick={onClose}>{t("common.cancel")}</button>
          <button
            className="primary"
            disabled={phase !== "plan-ready"}
            onClick={() => {
              void apply();
            }}
          >
            {phase === "applying" ? t("common.applying") : t("common.apply")}
          </button>
        </div>
      </div>
    </div>
  );
}
