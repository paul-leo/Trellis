import { useState } from "react";
import { useFetch } from "../lib/useFetch";
import { ConfirmModal } from "../components/ConfirmModal";
import { useI18n } from "../lib/i18n";

interface SkillListEntry {
  name: string;
  scope: string[];
}

type PendingAction = { operation: string; title: string; body?: Record<string, unknown> } | undefined;

export function SkillsView() {
  const { data, error, loading } = useFetch<SkillListEntry[]>("/skill/list");
  const { t } = useI18n();
  const [pending, setPending] = useState<PendingAction>();
  const [addName, setAddName] = useState("");
  const [addFrom, setAddFrom] = useState("");

  return (
    <section>
      <h2>{t("skills.title")}</h2>
      <p className="subtitle">{t("skills.subtitle")}</p>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <input placeholder={t("common.namePlaceholder")} value={addName} onChange={(e) => setAddName(e.currentTarget.value)} style={{ flex: 1 }} />
        <input placeholder={t("skills.fromPlaceholder")} value={addFrom} onChange={(e) => setAddFrom(e.currentTarget.value)} style={{ flex: 2 }} />
        <button
          disabled={!addName || !addFrom}
          onClick={() => setPending({ operation: "skill-add", title: t("skills.addTitle", { name: addName }), body: { name: addName, fromPath: addFrom } })}
        >
          {t("common.add")}
        </button>
        <button onClick={() => setPending({ operation: "sync", title: t("skills.syncTitle"), body: { target: "skills" } })}>{t("common.sync")}</button>
      </div>

      {loading && !data && <p className="empty-state">{t("common.loading")}</p>}
      {data?.length === 0 && <p className="empty-state">{t("skills.empty")}</p>}
      {data?.map((entry) => (
        <div className="card" key={entry.name}>
          <div className="card-row">
            <span className="card-title">{entry.name}</span>
            <button onClick={() => setPending({ operation: "skill-remove", title: t("skills.removeTitle", { name: entry.name }), body: { name: entry.name } })}>{t("common.remove")}</button>
          </div>
          <p className="subtitle" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
            {entry.scope.length > 0 ? entry.scope.join(", ") : t("common.noAgentReaches")}
          </p>
        </div>
      ))}

      {pending && (
        <ConfirmModal
          operation={pending.operation}
          title={pending.title}
          requestBody={pending.body}
          onClose={() => setPending(undefined)}
          onApplied={() => {
            setAddName("");
            setAddFrom("");
          }}
        />
      )}
    </section>
  );
}
