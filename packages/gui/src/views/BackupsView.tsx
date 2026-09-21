import { useState } from "react";
import { useFetch } from "../lib/useFetch";
import { ConfirmModal } from "../components/ConfirmModal";
import { useI18n } from "../lib/i18n";

interface BackupRunSummary {
  runId: string;
  command: string;
  startedAt: string;
  operationCount: number;
}

export function BackupsView() {
  const { data, error, loading } = useFetch<BackupRunSummary[]>("/backups/list");
  const { t } = useI18n();
  const [rollbackRunId, setRollbackRunId] = useState<string>();

  return (
    <section>
      <h2>{t("backups.title")}</h2>
      <p className="subtitle">{t("backups.subtitle")}</p>
      {error && <div className="error-banner">{error}</div>}
      {loading && !data && <p className="empty-state">{t("common.loading")}</p>}
      {data?.length === 0 && <p className="empty-state">{t("backups.empty")}</p>}
      {data?.map((run) => (
        <div className="card" key={run.runId}>
          <div className="card-row">
            <span className="card-title">{run.command}</span>
            <button onClick={() => setRollbackRunId(run.runId)}>{t("backups.rollback")}</button>
          </div>
          <p className="subtitle" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
            {t("backups.summary", { count: run.operationCount, startedAt: run.startedAt })}
          </p>
        </div>
      ))}

      {rollbackRunId && (
        <ConfirmModal
          operation="rollback"
          title={t("backups.rollbackTitle", { runId: rollbackRunId })}
          requestBody={{ runId: rollbackRunId }}
          onClose={() => setRollbackRunId(undefined)}
          onApplied={() => setRollbackRunId(undefined)}
        />
      )}
    </section>
  );
}
