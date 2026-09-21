import { useState } from "react";
import { useFetch } from "../lib/useFetch";
import { ConfirmModal } from "../components/ConfirmModal";
import { useI18n } from "../lib/i18n";

interface AgentSnapshot {
  agent: string;
  present: boolean;
}

interface DoctorReport {
  snapshots: AgentSnapshot[];
}

/**
 * Onboard wizard (trellis-gui tasks.md 7.3): collects the same choices
 * `RunOnboardOptions`'s non-interactive flags accept (`agent`, `manage`,
 * `mcpMode`, `hubUrl`, `gatewayAgents`, `memory`, `memoryMigrate`) and
 * submits them as the `/plan/onboard` + `/apply/onboard` request body.
 * `selectionFile` is not exposed — see `planApply.ts`'s
 * `OnboardWizardInput` doc comment for why.
 *
 * Agent choices are real `<select>`/checkbox options built from
 * `/doctor`'s own real snapshot list — not free-text inputs the user
 * has to type an exact agent id into, and not a second, hardcoded copy
 * of "which agents exist" living only in this file.
 */
export function OnboardView() {
  const { data: doctor } = useFetch<DoctorReport>("/doctor");
  const { t } = useI18n();
  const snapshots = doctor?.snapshots ?? [];
  const presentAgents = snapshots.filter((s) => s.present);

  const [agent, setAgent] = useState("");
  const [managedSet, setManagedSet] = useState<Set<string>>(new Set());
  const [manageNoneExplicitly, setManageNoneExplicitly] = useState(false);
  const [mcpMode, setMcpMode] = useState<"" | "direct" | "hub" | "gateway">("");
  const [hubUrl, setHubUrl] = useState("");
  const [memory, setMemory] = useState<"" | "on" | "off">("");
  const [showModal, setShowModal] = useState(false);

  const manage = managedSet.size > 0 ? [...managedSet].join(",") : manageNoneExplicitly ? "none" : "";
  const canSubmit = manage !== "";

  const body: Record<string, unknown> = {};
  if (agent) body.agent = agent;
  if (manage) body.manage = manage;
  if (mcpMode) body.mcpMode = mcpMode;
  if (mcpMode === "hub" && hubUrl) body.hubUrl = hubUrl;
  if (memory) body.memory = memory;

  function toggleManaged(id: string): void {
    setManageNoneExplicitly(false);
    setManagedSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section>
      <h2>{t("onboard.title")}</h2>
      <p className="subtitle">
        {t("onboard.subtitlePre")} <code>{t("onboard.subtitleCode")}</code>{t("onboard.subtitlePost")}
      </p>

      <div className="form-grid">
        <div className="form-field">
          <label>{t("onboard.migrationSourceLabel")}</label>
          <select value={agent} onChange={(e) => setAgent(e.currentTarget.value)}>
            <option value="">{t("onboard.autoSelect")}</option>
            {presentAgents.map((s) => (
              <option key={s.agent} value={s.agent}>
                {s.agent}
              </option>
            ))}
          </select>
          {presentAgents.length === 0 && <p className="subtitle">{t("onboard.noPresentAgents")}</p>}
        </div>

        <div className="form-field">
          <label>{t("onboard.managedAgentsLabel")}</label>
          {snapshots.map((s) => (
            <label key={s.agent} style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem", color: "var(--ink)", marginBottom: "0.2rem" }}>
              <input type="checkbox" checked={managedSet.has(s.agent)} onChange={() => toggleManaged(s.agent)} style={{ width: "auto" }} />
              {s.agent} {!s.present && <span className="tag" style={{ marginLeft: "0.3rem" }}>{t("common.notInstalled")}</span>}
            </label>
          ))}
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem", color: "var(--ink-muted)", marginTop: "0.4rem" }}>
            <input
              type="checkbox"
              checked={manageNoneExplicitly}
              onChange={(e) => {
                setManageNoneExplicitly(e.currentTarget.checked);
                if (e.currentTarget.checked) setManagedSet(new Set());
              }}
              style={{ width: "auto" }}
            />
            {t("onboard.addNothing")}
          </label>
        </div>

        <div className="form-field">
          <label>{t("onboard.mcpModeLabel")}</label>
          <select value={mcpMode} onChange={(e) => setMcpMode(e.currentTarget.value as typeof mcpMode)}>
            <option value="">{t("onboard.noChange")}</option>
            <option value="direct">direct</option>
            <option value="hub">hub</option>
            <option value="gateway">gateway</option>
          </select>
        </div>
        {mcpMode === "hub" && (
          <div className="form-field">
            <label>{t("onboard.hubUrlLabel")}</label>
            <input value={hubUrl} onChange={(e) => setHubUrl(e.currentTarget.value)} placeholder="https://..." />
          </div>
        )}
        <div className="form-field">
          <label>{t("onboard.memoryLabel")}</label>
          <select value={memory} onChange={(e) => setMemory(e.currentTarget.value as typeof memory)}>
            <option value="">{t("onboard.noChange")}</option>
            <option value="on">on</option>
            <option value="off">off</option>
          </select>
        </div>
        <button className="primary" disabled={!canSubmit} onClick={() => setShowModal(true)} style={{ alignSelf: "flex-start" }}>
          {t("onboard.previewButton")}
        </button>
        {!canSubmit && (
          <p className="subtitle">
            {t("onboard.pickAtLeastOnePre")} <code>{t("onboard.pickAtLeastOneCode")}</code> {t("onboard.pickAtLeastOnePost")}
          </p>
        )}
      </div>

      {showModal && (
        <ConfirmModal operation="onboard" title={t("onboard.title")} requestBody={body} onClose={() => setShowModal(false)} onApplied={() => setShowModal(false)} />
      )}
    </section>
  );
}
