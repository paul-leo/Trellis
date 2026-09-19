/** Safe import of standard JSON `mcpServers` exports.
 *
 * This is deliberately separate from `mcp add`: an export may contain real
 * credentials, multiple differently-named copies of one server, and shapes
 * that cannot be expressed safely for every native Agent. The source file is
 * read-only; plans never carry secret values.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCanonicalSource, ensureGitignoreEntry, ensureShellEnvSource, upsertServerYaml, writeSecretsPolicyExtraction } from "../core/canonical.js";
import type { McpServerDef, Transport } from "../core/types.js";
import { openBackupSession, type BackupSession } from "../lib/backup.js";
import { parseDotenv, writeLocalSecretValue } from "../lib/secretEnv.js";

const DEFAULT_ENV_FILE_TILDE = "~/.trellis/mcp/servers.local.env";

interface ExportServer {
  type?: unknown;
  transport?: unknown;
  command?: unknown;
  args?: unknown;
  url?: unknown;
  headers?: unknown;
  env?: unknown;
  disabled?: unknown;
  enabled?: unknown;
  auth?: unknown;
}

interface ExportDocument {
  mcpServers?: unknown;
}

export type McpImportAction = "create" | "already-present" | "duplicate" | "skipped" | "conflict" | "invalid-input";

export interface McpImportItem {
  name: string;
  action: McpImportAction;
  detail: string;
}

interface SecretWrite {
  name: string;
  value: string;
}

interface PlannedAddition {
  name: string;
  def: McpServerDef;
}

export interface McpImportPlan {
  source: string;
  items: McpImportItem[];
}

interface InternalPlan extends McpImportPlan {
  additions: PlannedAddition[];
  secrets: SecretWrite[];
  envFilePath: string;
  envFileIsDefault: boolean;
}

class SkipImport extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${field} must be an array of strings`);
  return value as string[];
}

function looksLikeCredentialKey(key: string): boolean {
  return /(token|secret|password|authorization|api.?key|bearer|credential|private.?key|headers?)/i.test(key);
}

function looksLikeCredentialValue(value: string): boolean {
  return /(mcpr_|ghp_|glpat-|sk-[A-Za-z0-9]{8,}|basic\s+[A-Za-z0-9+/=]{12,}|bearer\s+\S+)/i.test(value);
}

function exactReference(value: string): string | undefined {
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  return match?.[1];
}

function sanitizeEnvPart(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "X";
}

function generatedSecretName(server: string, key: string): string {
  return `TRELLIS_${sanitizeEnvPart(server)}_${sanitizeEnvPart(key)}`;
}

function defaultShellRcPath(homeDir: string): string {
  const shell = process.env.SHELL ?? "";
  if (shell.includes("zsh")) return join(homeDir, ".zshrc");
  if (shell.includes("bash")) return join(homeDir, ".bash_profile");
  return join(homeDir, ".profile");
}

function inferTransport(raw: ExportServer): Transport {
  const value = raw.transport ?? raw.type;
  if (value === "http" || value === "sse" || value === "stdio") return value;
  if (raw.url !== undefined) return "http";
  return "stdio";
}

function sorted(values: string[]): string[] {
  return [...values].sort();
}

function identityArgs(def: McpServerDef): string[] | undefined {
  if (!def.args) return undefined;
  if (def.command !== "npx") return def.args;
  // MCP exports often omit npx's non-interactive confirmation flag while the
  // canonical adapter adds it. It changes prompting, not server identity.
  const normalized = def.args.filter((arg) => arg !== "-y" && arg !== "--yes");
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeMcpRemote(serverName: string, args: string[], secrets: SecretWrite[]): McpServerDef | undefined {
  const remoteIndex = args.indexOf("mcp-remote");
  if (remoteIndex < 0) return undefined;
  const url = args[remoteIndex + 1];
  if (!url || !/^https?:\/\//.test(url)) throw new Error(`MCP server "${serverName}" has an invalid mcp-remote URL`);
  const headerIndex = args.indexOf("--header", remoteIndex + 2);
  const allowed = new Set(["-y", "--yes", "mcp-remote", url, "--header", ...(headerIndex >= 0 && args[headerIndex + 1] ? [args[headerIndex + 1]!] : [])]);
  if (args.some((arg) => !allowed.has(arg))) throw new Error(`MCP server "${serverName}" has unsupported mcp-remote arguments; import it manually after reviewing the shape`);
  if (headerIndex < 0) return { transport: "http", url };
  const header = args[headerIndex + 1];
  const match = /^Authorization:\s*Basic\s+(.+)$/i.exec(header ?? "");
  if (!match) throw new Error(`MCP server "${serverName}" has an unsupported mcp-remote header; only Basic Authorization can be migrated safely`);
  const rawCredential = match[1]!;
  const reference = exactReference(rawCredential);
  const sourceName = generatedSecretName(serverName, "AUTHORIZATION");
  if (reference) {
    return { transport: "http", url, headers: { Authorization: `Basic \${${reference}}` } };
  }
  secrets.push({ name: sourceName, value: rawCredential });
  return { transport: "http", url, headers: { Authorization: `Basic \${${sourceName}}` } };
}

/** Identity deliberately ignores secret values and generated source names but
 * retains target env/header keys, so notion and notionApi do not collapse. */
function semanticIdentity(def: McpServerDef): string {
  return JSON.stringify({
    transport: def.transport,
    auth: def.auth,
    command: def.command,
    args: identityArgs(def),
    url: def.url,
    enabled: def.enabled,
    agents: def.agents ? sorted(def.agents) : undefined,
    staticEnv: def.staticEnv,
    envKeys: sorted([...(def.env ?? []), ...Object.keys(def.envAliases ?? {})]),
    headerKeys: sorted(Object.keys(def.headers ?? {})),
  });
}

function normalizeEntry(serverName: string, raw: ExportServer, secrets: SecretWrite[]): McpServerDef {
  if (!isRecord(raw)) throw new Error(`MCP server "${serverName}" must be an object`);
  const transport = inferTransport(raw);
  const command = stringValue(raw.command, `${serverName}.command`);
  const parsedArgs = stringArray(raw.args, `${serverName}.args`);
  const args = parsedArgs && parsedArgs.length > 0 ? parsedArgs : undefined;
  const url = stringValue(raw.url, `${serverName}.url`);
  if (transport === "stdio" && !command) throw new Error(`MCP server "${serverName}" is stdio but has no command`);
  if ((transport === "http" || transport === "sse") && !url) throw new Error(`MCP server "${serverName}" is ${transport} but has no url`);

  if (command === "npx" && args) {
    const remote = normalizeMcpRemote(serverName, args, secrets);
    if (remote) {
      if (raw.env !== undefined || raw.headers !== undefined) {
        throw new Error(`MCP server "${serverName}" combines mcp-remote arguments with env/headers fields; import it manually after reviewing the merge`);
      }
      return {
        ...remote,
        ...(raw.auth === "oauth" ? { auth: "oauth" as const } : {}),
        ...(raw.disabled === true || raw.enabled === false ? { enabled: false } : {}),
      };
    }
  }

  const env: string[] = [];
  const envAliases: Record<string, string> = {};
  const staticEnv: Record<string, string> = {};
  if (raw.env !== undefined) {
    if (!isRecord(raw.env)) throw new Error(`${serverName}.env must be an object`);
    for (const [targetKey, rawValue] of Object.entries(raw.env)) {
      const value = stringValue(rawValue, `${serverName}.env.${targetKey}`)!;
      const reference = exactReference(value);
      if (reference) {
        if (reference === targetKey) env.push(reference);
        else envAliases[targetKey] = reference;
        continue;
      }
      if (looksLikeCredentialKey(targetKey) || looksLikeCredentialValue(value)) {
        const sourceName = generatedSecretName(serverName, targetKey);
        envAliases[targetKey] = sourceName;
        secrets.push({ name: sourceName, value });
      } else {
        staticEnv[targetKey] = value;
      }
    }
  }

  const headers: Record<string, string> = {};
  if (raw.headers !== undefined) {
    if (!isRecord(raw.headers)) throw new Error(`${serverName}.headers must be an object`);
    for (const [key, rawValue] of Object.entries(raw.headers)) {
      const value = stringValue(rawValue, `${serverName}.headers.${key}`)!;
      const reference = exactReference(value);
      if (reference) {
        headers[key] = `\${${reference}}`;
        continue;
      }
      throw new Error(`MCP server "${serverName}" has a literal header "${key}"; move it to an environment variable before importing`);
    }
  }

  const inlineText = [command, ...(args ?? []), url].filter(Boolean).join(" ");
  if (looksLikeCredentialValue(inlineText)) {
    throw new Error(`MCP server "${serverName}" has a credential embedded in command, args, or url; importer will not store it in canonical`);
  }
  for (const arg of args ?? []) {
    if (/^(\/Users\/|\/home\/|[A-Za-z]:[\\/])/.test(arg) && !existsSync(arg)) {
      throw new SkipImport(`MCP server "${serverName}" references missing absolute path "${arg}"; skipped as unavailable on this machine`);
    }
  }

  const disabled = raw.disabled === true || raw.enabled === false;
  const auth = raw.auth === "oauth" ? "oauth" as const : undefined;
  return {
    transport,
    ...(auth ? { auth } : {}),
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    ...(url ? { url } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(env.length > 0 ? { env } : {}),
    ...(Object.keys(envAliases).length > 0 ? { envAliases } : {}),
    ...(Object.keys(staticEnv).length > 0 ? { staticEnv } : {}),
    ...(disabled ? { enabled: false } : {}),
  };
}

function readExport(path: string): Record<string, ExportServer> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ExportDocument;
  if (!isRecord(parsed.mcpServers)) throw new Error(`MCP import requires a top-level "mcpServers" object in ${path}`);
  return parsed.mcpServers as Record<string, ExportServer>;
}

function publicPlan(plan: InternalPlan): McpImportPlan {
  return { source: plan.source, items: plan.items };
}

export function collectMcpImportPlan(path: string, homeDir: string = homedir()): McpImportPlan {
  return publicPlan(collectInternalPlan(path, homeDir));
}

function collectInternalPlan(path: string, homeDir: string): InternalPlan {
  if (!existsSync(path)) throw new Error(`MCP import file does not exist: ${path}`);
  const source = readExport(path);
  const canonical = loadCanonicalSource(homeDir);
  const existingByIdentity = new Map(Object.entries(canonical.mcp.servers).map(([name, def]) => [semanticIdentity(def), name]));
  const additions: PlannedAddition[] = [];
  const secrets: SecretWrite[] = [];
  const items: McpImportItem[] = [];
  const envFilePath = canonical.secretsPolicy.envFile ?? join(homeDir, ".trellis", "mcp", "servers.local.env");
  const existingSecrets = existsSync(envFilePath) ? parseDotenv(readFileSync(envFilePath, "utf8")) : {};

  for (const [name, raw] of Object.entries(source)) {
    let def: McpServerDef;
    const beforeSecretCount = secrets.length;
    try {
      def = normalizeEntry(name, raw, secrets);
    } catch (err) {
      secrets.splice(beforeSecretCount);
      if (err instanceof SkipImport) {
        items.push({ name, action: "skipped", detail: err.message });
        continue;
      }
      items.push({ name, action: "conflict", detail: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const identity = semanticIdentity(def);
    const existing = canonical.mcp.servers[name];
    if (existing) {
      secrets.splice(beforeSecretCount);
      items.push(existing && semanticIdentity(existing) === identity
        ? { name, action: "already-present", detail: "canonical entry is already semantically identical; existing credentials are preserved" }
        : { name, action: "conflict", detail: `servers.yaml already has "${name}" with different non-secret settings — left unchanged` });
      continue;
    }
    const duplicate = existingByIdentity.get(identity) ?? additions.find((item) => semanticIdentity(item.def) === identity)?.name;
    if (duplicate) {
      secrets.splice(beforeSecretCount);
      items.push({ name, action: "duplicate", detail: `same non-secret MCP definition is already represented by "${duplicate}" — not added` });
      continue;
    }
    const newSecrets = secrets.slice(beforeSecretCount);
    const secretConflict = newSecrets.find((secret) => Object.hasOwn(existingSecrets, secret.name) && existingSecrets[secret.name] !== secret.value);
    if (secretConflict) {
      secrets.splice(beforeSecretCount);
      items.push({ name, action: "conflict", detail: `local secret variable "${secretConflict.name}" already has a different value — not overwritten` });
      continue;
    }
    additions.push({ name, def });
    items.push({ name, action: "create", detail: `will add to canonical and extract ${newSecrets.length} credential value(s) to the ignored local secrets file` });
  }
  return { source: path, items, additions, secrets, envFilePath, envFileIsDefault: !canonical.secretsPolicy.envFile };
}

function applySecrets(plan: InternalPlan, homeDir: string, backup: BackupSession): void {
  if (plan.secrets.length === 0) return;
  if (plan.envFileIsDefault) ensureGitignoreEntry(join(homeDir, ".trellis", ".gitignore"), "mcp/servers.local.env", backup);
  for (const secret of plan.secrets) {
    const secretResult = writeLocalSecretValue(plan.envFilePath, secret.name, secret.value, backup);
    if (secretResult === "conflict") throw new Error(`local secret variable "${secret.name}" changed during import — refusing to overwrite it`);
    const policyResult = writeSecretsPolicyExtraction(join(homeDir, ".trellis", "secrets.policy.yaml"), { varName: secret.name, envFilePath: DEFAULT_ENV_FILE_TILDE }, backup);
    if (!policyResult.ok) throw new Error(policyResult.error);
  }
  ensureShellEnvSource(defaultShellRcPath(homeDir), plan.envFilePath, backup);
}

export function applyMcpImportPlan(path: string, homeDir: string = homedir(), backup?: BackupSession): McpImportPlan {
  const plan = collectInternalPlan(path, homeDir);
  const ownSession = backup ?? openBackupSession(homeDir, "mcp-import");
  try {
    for (const addition of plan.additions) {
      const result = upsertServerYaml(join(homeDir, ".trellis", "mcp", "servers.yaml"), addition.name, addition.def, ownSession);
      if (!result.ok) throw new Error(result.error);
    }
    applySecrets(plan, homeDir, ownSession);
  } catch (error) {
    // Keep the manifest even on failure so the caller can use the normal
    // `trellis rollback` path to undo writes that happened before the error.
    if (!backup) ownSession.finalize();
    throw error;
  }
  if (!backup) ownSession.finalize();
  return publicPlan(plan);
}

export function runMcpImport(path: string | undefined, opts: { homeDir?: string; json?: boolean; dryRun?: boolean } = {}): { exitCode: number } {
  const homeDir = opts.homeDir ?? homedir();
  if (!path) {
    console.error("Usage: trellis mcp import <json-file> [--dry-run]");
    return { exitCode: 1 };
  }
  try {
    const internal = collectInternalPlan(path, homeDir);
    if (!opts.dryRun) applyMcpImportPlan(path, homeDir);
    const result = publicPlan(internal);
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${opts.dryRun ? "[dry run] " : ""}mcp import ${path}`);
      for (const item of result.items) console.log(`  [${item.action}] ${item.name} — ${item.detail}`);
    }
    return { exitCode: result.items.some((item) => item.action === "conflict" || item.action === "invalid-input") ? 1 : 0 };
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }
}
