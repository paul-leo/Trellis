import { useState } from "react";
import { useFetch } from "../lib/useFetch";
import { ConfirmModal } from "../components/ConfirmModal";
import { ScopeEditor, scopeSelection } from "../components/ScopeEditor";
import { useI18n } from "../lib/i18n";

interface McpListEntry {
  name: string;
  transport: string;
  enabled: boolean;
  agents: string[];
  auth?: "oauth";
  preRegisteredClient?: true;
  /** Credential state for OAuth-classified servers — not connection health. */
  authStatus?: "authorized" | "refreshable" | "expired" | "not-authorized";
  authExpiresAt?: number;
  command?: string;
  url?: string;
}

type PendingAction = { operation: string; title: string; body?: Record<string, unknown> } | undefined;

export function McpView() {
  const { data, error, loading } = useFetch<McpListEntry[]>("/mcp/list");
  const managed = useFetch<{ managedAgents: string[] }>("/managed").data?.managedAgents ?? [];
  const { t } = useI18n();
  const [pending, setPending] = useState<PendingAction>();
  const [addName, setAddName] = useState("");
  const [addCommand, setAddCommand] = useState("");
  const [importPath, setImportPath] = useState("");

  return (
    <section>
      <h2>{t("mcp.title")}</h2>
      <p className="subtitle">{t("mcp.subtitle")}</p>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <input placeholder={t("common.namePlaceholder")} value={addName} onChange={(e) => setAddName(e.currentTarget.value)} style={{ flex: 1 }} />
        <input placeholder={t("mcp.commandPlaceholder")} value={addCommand} onChange={(e) => setAddCommand(e.currentTarget.value)} style={{ flex: 2 }} />
        <button
          disabled={!addName || !addCommand}
          onClick={() => setPending({ operation: "mcp-add", title: t("mcp.addTitle", { name: addName }), body: { name: addName, raw: { transport: "stdio", command: addCommand } } })}
        >
          {t("common.add")}
        </button>
        <button onClick={() => setPending({ operation: "mcp-sync", title: t("mcp.syncTitle") })}>{t("common.sync")}</button>
      </div>

      <div className="card" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <input
          placeholder={t("mcp.importPlaceholder")}
          value={importPath}
          onChange={(e) => setImportPath(e.currentTarget.value)}
          style={{ flex: 1 }}
        />
        <button disabled={!importPath} onClick={() => setPending({ operation: "mcp-import", title: t("mcp.importTitle", { path: importPath }), body: { path: importPath } })}>
          {t("mcp.import")}
        </button>
      </div>
      <p className="subtitle" style={{ marginTop: "-0.25rem" }}>
        {t("mcp.importHintPre")} <code>{t("mcp.importHintCode")}</code> {t("mcp.importHintPost")} <code>{t("mcp.importHintCode2")}</code>.
      </p>

      {loading && !data && <p className="empty-state">{t("common.loading")}</p>}
      {data?.length === 0 && <p className="empty-state">{t("mcp.empty")}</p>}
      {data?.map((entry) => (
        <div className="card" key={entry.name}>
          <div className="card-row">
            <span className="card-title">{entry.name}</span>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <span className="tag">{entry.transport}</span>
              {!entry.enabled && <span className="tag warn">{t("mcp.disabled")}</span>}
              {entry.preRegisteredClient && <span className="tag">{t("mcp.preRegistered")}</span>}
              {entry.authStatus && (
                <span className={`tag ${entry.authStatus === "authorized" ? "ok" : entry.authStatus === "refreshable" ? "" : "warn"}`} title={t("mcp.credentialNote")}>
                  {t("mcp.credential")}: {t(`mcp.credential.${entry.authStatus}`)}
                  {entry.authStatus === "authorized" && entry.authExpiresAt
                    ? ` · ${t("mcp.credential.expires", { date: new Date(entry.authExpiresAt).toLocaleString() })}`
                    : ""}
                </span>
              )}
              <button onClick={() => setPending({ operation: "mcp-remove", title: t("mcp.removeTitle", { name: entry.name }), body: { name: entry.name } })}>{t("common.remove")}</button>
            </div>
          </div>
          {(entry.authStatus === "not-authorized" || entry.authStatus === "expired") && (
            <p className="subtitle" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
              {t("mcp.credential.runHint")} <code>trellis mcp auth {entry.name}</code>
            </p>
          )}
          <ScopeEditor
            key={`${entry.name}:${entry.agents.join(",")}`}
            managed={managed}
            current={entry.agents}
            onSave={(selected) =>
              setPending({ operation: "mcp-scope", title: t("scope.mcpTitle", { name: entry.name }), body: { name: entry.name, selection: scopeSelection(selected) } })
            }
          />
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
            setAddCommand("");
            setImportPath("");
          }}
        />
      )}
    </section>
  );
}
