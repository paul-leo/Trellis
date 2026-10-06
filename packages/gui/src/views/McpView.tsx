import { useState } from "react";
import { useFetch } from "../lib/useFetch";
import { ConfirmModal } from "../components/ConfirmModal";
import { ScopeEditor, scopeSelection } from "../components/ScopeEditor";
import { useI18n } from "../lib/i18n";
import { OAuthAuthorization } from "../components/OAuthAuthorization";

interface McpListEntry {
  name: string;
  transport: string;
  enabled: boolean;
  agents: string[];
  auth?: "oauth";
  authOwner?: "agent" | "trellis";
  agentAuthorization?: Array<{ agent: string; status: "unknown"; instruction: string }>;
  preRegisteredClient?: true;
  /** Credential state for OAuth-classified servers — not connection health. */
  authStatus?: "authorized" | "refreshable" | "expired" | "not-authorized" | "unknown";
  authExpiresAt?: number;
  command?: string;
  url?: string;
}

type PendingAction = { operation: string; title: string; body?: Record<string, unknown> } | undefined;

export function McpView() {
  const { data, error, loading, refresh } = useFetch<McpListEntry[]>("/mcp/list");
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
        <div className="card" key={entry.name} role="group" aria-label={entry.name}>
          <div className="card-row">
            <span className="card-title">{entry.name}</span>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <span className="tag">{entry.transport}</span>
              {!entry.enabled && <span className="tag warn">{t("mcp.disabled")}</span>}
              {entry.preRegisteredClient && <span className="tag">{t("mcp.preRegistered")}</span>}
              {entry.authOwner && <span className="tag">{t(`mcp.owner.${entry.authOwner}`)}</span>}
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
          {entry.url && <div style={{ marginTop: "0.5rem" }}>
            <label>{t("mcp.owner.label")} <select aria-label={t("mcp.owner.label")} value={entry.auth === "oauth" ? entry.authOwner ?? "agent" : "none"} onChange={(e) => setPending({ operation: "mcp-auth-owner", title: t("mcp.owner.changeTitle", { name: entry.name }), body: { name: entry.name, owner: e.currentTarget.value } })}>
              <option value="none">{t("mcp.owner.none")}</option>
              <option value="agent">{t("mcp.owner.agent")}</option>
              <option value="trellis">{t("mcp.owner.trellis")}</option>
            </select></label>
            {entry.auth === "oauth" && (entry.authOwner === "trellis" ? <OAuthAuthorization server={entry.name} authorized={entry.authStatus === "authorized"} onAuthorized={refresh} /> : <>
              <p className="subtitle">{t("mcp.owner.nativeNote")}</p>
              {entry.agentAuthorization?.map(({ agent, instruction }) => <p key={agent}><span className="tag">{agent}</span> {t("mcp.credential.unknown")} · {agent === "codex" ? <code>{instruction}</code> : t(agent === "claude-code" ? "mcp.owner.claudeEntry" : "mcp.owner.agentSettings")}</p>)}
            </>)}
          </div>}
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
            refresh();
            setAddName("");
            setAddCommand("");
            setImportPath("");
          }}
        />
      )}
    </section>
  );
}
