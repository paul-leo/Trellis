import { useFetch } from "../lib/useFetch";
import { useI18n } from "../lib/i18n";

interface SecretsFinding {
  agent: string;
  file: string;
  kind: string;
  detail: string;
}

interface SecretsAuditReport {
  findings: SecretsFinding[];
}

export function SecretsView() {
  const { data, error, loading } = useFetch<SecretsAuditReport>("/secrets/audit");
  const { t } = useI18n();

  return (
    <section>
      <h2>{t("secrets.title")}</h2>
      <p className="subtitle">{t("secrets.subtitle")}</p>
      {error && <div className="error-banner">{error}</div>}
      {loading && !data && <p className="empty-state">{t("common.loading")}</p>}
      {data?.findings.length === 0 && <p className="empty-state">{t("secrets.empty")}</p>}
      {data && data.findings.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{t("secrets.colAgent")}</th>
              <th>{t("secrets.colFile")}</th>
              <th>{t("secrets.colKind")}</th>
              <th>{t("secrets.colDetail")}</th>
            </tr>
          </thead>
          <tbody>
            {data.findings.map((f, i) => (
              <tr key={i}>
                <td>{f.agent}</td>
                <td>{f.file}</td>
                <td>{f.kind}</td>
                <td>{f.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
