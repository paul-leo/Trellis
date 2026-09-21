import { useFetch } from "../lib/useFetch";
import { useI18n } from "../lib/i18n";

interface AgentSnapshot {
  agent: string;
  present: boolean;
  version?: string;
  skillRoots: Array<{ skills: unknown[] }>;
  mcpServers: unknown[];
  diagnostics: string[];
}

interface Finding {
  kind: string;
  agent?: string;
  message: string;
}

interface DoctorReport {
  snapshots: AgentSnapshot[];
  findings: Finding[];
}

export function AgentsView() {
  const { data, error, loading } = useFetch<DoctorReport>("/doctor");
  const { t } = useI18n();

  return (
    <section>
      <h2>{t("agents.title")}</h2>
      <p className="subtitle">{t("agents.subtitle")}</p>
      {error && <div className="error-banner">{error}</div>}
      {loading && !data && <p className="empty-state">{t("common.loading")}</p>}
      {data?.snapshots.map((snap) => {
        const skillCount = snap.skillRoots.reduce((sum, root) => sum + root.skills.length, 0);
        return (
          <div className="card" key={snap.agent}>
            <div className="card-row">
              <span className="card-title">{snap.agent}</span>
              <span className={`tag ${snap.present ? "ok" : ""}`}>{snap.present ? t("common.present") : t("common.notInstalled")}</span>
            </div>
            {snap.present && (
              <p className="subtitle" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
                {t("agents.summary", { count: skillCount, mcpCount: snap.mcpServers.length })}
                {snap.version ? ` · ${snap.version}` : ""}
              </p>
            )}
            {snap.diagnostics.length > 0 && (
              <ul style={{ margin: "0.5rem 0 0 0", paddingLeft: "1.2rem", color: "var(--danger)", fontSize: "0.8rem" }}>
                {snap.diagnostics.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {data && data.findings.length > 0 && (
        <>
          <h2 style={{ marginTop: "2rem" }}>{t("agents.findings")}</h2>
          {data.findings.map((f, i) => (
            <div className="card" key={i}>
              <div className="card-row">
                <span>{f.message}</span>
                <span className="tag warn">{f.kind}</span>
              </div>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
