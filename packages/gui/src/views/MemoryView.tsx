import { useFetch } from "../lib/useFetch";
import { useI18n } from "../lib/i18n";

interface MemoryListEntry {
  name: string;
  scope: string[];
}

export function MemoryView() {
  const { data, error, loading } = useFetch<MemoryListEntry[]>("/memory/list");
  const { t } = useI18n();

  return (
    <section>
      <h2>{t("memory.title")}</h2>
      <p className="subtitle">{t("memory.subtitle")}</p>
      {error && <div className="error-banner">{error}</div>}
      {loading && !data && <p className="empty-state">{t("common.loading")}</p>}
      {data?.length === 0 && <p className="empty-state">{t("memory.empty")}</p>}
      {data?.map((entry) => (
        <div className="card" key={entry.name}>
          <div className="card-row">
            <span className="card-title">{entry.name}</span>
          </div>
          <p className="subtitle" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
            {entry.scope.length > 0 ? entry.scope.join(", ") : t("common.noAgentReaches")}
          </p>
        </div>
      ))}
    </section>
  );
}
