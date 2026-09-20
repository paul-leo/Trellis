/**
 * `trellis mcp sync|list|add|remove` — `sync` loads canonical once, runs
 * every present agent's adapter, applies its full "mcp" plan (create,
 * repair, and — since trellis-mcp-lifecycle-parity, ownership-ledger-
 * gated — remove), and reports what happened. Kept as a separate
 * command from bare `trellis sync` (skills/instructions) since the two
 * have different write mechanisms entirely, not because MCP removal is
 * unsafe (see `src/lib/mcpOwnership.ts`). `add`/`remove` mutate the
 * canonical source and then run the same sync `mcp sync` performs, so
 * one command both edits the list and maps it onto the managed agents
 * (removal propagates through the ownership ledger). `list` is
 * read-only. All three are an alternative to hand-editing
 * `~/.trellis/mcp/servers.yaml`.
 */

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadCanonicalSource, upsertServerYaml, removeServerYaml, type ServersYamlWriteResult } from "../core/canonical.js";
import type { AdapterPlanItem, TrellisAdapter } from "../core/adapter.js";
import { ALL_AGENTS, resolveScope } from "../core/types.js";
import type { AgentId, McpAuthMode, McpConfig, McpServerDef, Transport } from "../core/types.js";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { CodexAdapter } from "../adapters/codex.js";
import { KiroAdapter } from "../adapters/kiro.js";
import { PiAdapter } from "../adapters/pi.js";
import { KimiCodeAdapter } from "../adapters/kimi-code.js";
import { openBackupSession, type BackupSession } from "../lib/backup.js";

export interface RunMcpSyncOptions {
  json?: boolean;
  /** Same test/sandbox-only seam as `RunSyncOptions.homeDir` — never a CLI
   * flag. See docs/architecture.md's testing philosophy. */
  homeDir?: string;
  /** Compute and report the plan without calling adapter.apply(). */
  dryRun?: boolean;
  /** Onboard-only seam — see RunSyncOptions.managedAgents. Never a CLI
   * flag. */
  managedAgents?: readonly AgentId[];
  /** Onboard-only canonical MCP override used to preview a route selection
   * before writing it to servers.yaml. */
  mcp?: McpConfig;
  /** Onboard-only seam — see RunSyncOptions.backupSession. Never a CLI
   * flag. */
  backupSession?: BackupSession;
}

export interface AgentMcpSyncReport {
  agent: AgentId;
  present: boolean;
  items: AdapterPlanItem[];
}

export interface McpSyncReport {
  reports: AgentMcpSyncReport[];
}

const ADAPTER_FACTORY: Record<AgentId, (homeDir: string) => TrellisAdapter> = {
  "claude-code": (homeDir) => new ClaudeCodeAdapter(homeDir),
  codex: (homeDir) => new CodexAdapter(homeDir),
  kiro: (homeDir) => new KiroAdapter(homeDir),
  pi: (homeDir) => new PiAdapter(homeDir),
  "kimi-code": (homeDir) => new KimiCodeAdapter(homeDir),
};

/** Only agents in `canonical.managedAgents` — see src/commands/sync.ts's
 * own copy of this same restriction (trellis-managed-agents). */
function buildAdapters(homeDir: string, managedAgents: readonly AgentId[]): TrellisAdapter[] {
  return managedAgents.map((id) => ADAPTER_FACTORY[id](homeDir));
}

export async function collectMcpSyncReport(opts: RunMcpSyncOptions = {}): Promise<McpSyncReport> {
  const homeDir = opts.homeDir ?? homedir();
  const loaded = loadCanonicalSource(homeDir);
  const canonical = {
    ...loaded,
    ...(opts.managedAgents ? { managedAgents: opts.managedAgents } : {}),
    ...(opts.mcp ? { mcp: opts.mcp } : {}),
  };
  const reports: AgentMcpSyncReport[] = [];
  const ownSession = !opts.dryRun && !opts.backupSession ? openBackupSession(homeDir, "mcp-sync") : undefined;
  const backup = opts.backupSession ?? ownSession;

  for (const adapter of buildAdapters(homeDir, canonical.managedAgents)) {
    const probeResult = await adapter.probe();
    if (!probeResult.present) {
      reports.push({ agent: adapter.id, present: false, items: [] });
      continue;
    }

    const items = (await adapter.plan(canonical)).filter((item) => item.kind === "mcp");
    if (!opts.dryRun) {
      await adapter.apply(items, backup!);
    }
    reports.push({ agent: adapter.id, present: true, items });
  }

  ownSession?.finalize();
  return { reports };
}

export async function runMcpSync(opts: RunMcpSyncOptions = {}): Promise<{ exitCode: number }> {
  let report: McpSyncReport;
  try {
    report = await collectMcpSyncReport(opts);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report, opts.dryRun ?? false);
  }

  const hasConflict = report.reports.some((r) => r.items.some((i) => i.action === "conflict"));
  return { exitCode: hasConflict ? 1 : 0 };
}

/** Exported so `onboard` prints an mcp-sync report identically to running
 * `mcp sync` standalone, instead of a second, easily-drifting copy of this
 * formatting. */
export function printReport(report: McpSyncReport, dryRun: boolean): void {
  if (dryRun) console.log("[dry run]");
  if (report.reports.length === 0) {
    console.log("No managed agents yet — run `trellis onboard` or list agent ids in ~/.trellis/managed.yaml.");
    return;
  }
  for (const { agent, present, items } of report.reports) {
    if (!present) {
      console.log(`—  ${agent} (not installed)`);
      continue;
    }
    const created = items.filter((i) => i.action === "create");
    const removed = items.filter((i) => i.action === "remove");
    const conflicts = items.filter((i) => i.action === "conflict");

    if (created.length === 0 && removed.length === 0 && conflicts.length === 0) {
      console.log(`✅ ${agent} — already in sync`);
      continue;
    }

    const icon = conflicts.length > 0 ? "⚠️ " : "✅";
    console.log(`${icon} ${agent} — ${created.length} created/updated, ${removed.length} removed, ${conflicts.length} conflict(s)`);
    for (const item of [...created, ...removed, ...conflicts]) {
      console.log(`   - [${item.action}] ${item.description}`);
    }
  }
}

function serversYamlPath(homeDir: string): string {
  return join(homeDir, ".trellis", "mcp", "servers.yaml");
}

export interface McpListEntry {
  name: string;
  transport: Transport;
  auth?: McpAuthMode;
  enabled: boolean;
  agents: readonly AgentId[];
  command?: string;
  args?: string[];
  url?: string;
  /** Reference strings (e.g. `${VAR}`), not resolved secret values — see
   * design.md D6. */
  headers?: Record<string, string>;
  /** Names only — `McpServerDef.env` never stores values in the first
   * place, so there is nothing here to redact. */
  env?: string[];
  /** Non-secret by `McpServerDef`'s own contract (design.md D6) —
   * printed in full. */
  staticEnv?: Record<string, string>;
}

export function collectMcpListPlan(homeDir: string = homedir()): McpListEntry[] {
  const canonical = loadCanonicalSource(homeDir);
  return Object.entries(canonical.mcp.servers).map(([name, def]) => ({
    name,
    transport: def.transport,
    auth: def.auth,
    enabled: def.enabled ?? true,
    agents: resolveScope(def.agents, canonical.managedAgents),
    command: def.command,
    args: def.args,
    url: def.url,
    headers: def.headers,
    env: def.env,
    staticEnv: def.staticEnv,
  }));
}

export function runMcpList(opts: { homeDir?: string; json?: boolean } = {}): { exitCode: number } {
  const homeDir = opts.homeDir ?? homedir();
  let entries: McpListEntry[];
  try {
    entries = collectMcpListPlan(homeDir);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }

  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2));
  } else if (entries.length === 0) {
    console.log("No MCP servers in canonical source yet.");
  } else {
    for (const e of entries) {
      const scope = e.agents.length > 0 ? e.agents.join(", ") : "(no managed agent reaches it)";
      console.log(`${e.name} (${e.transport}${e.auth === "oauth" ? ", oauth" : ""})${e.enabled ? "" : " [disabled]"} — ${scope}`);
      if (e.env && e.env.length > 0) console.log(`   env: ${e.env.join(", ")} (values never read/printed)`);
      if (e.staticEnv) console.log(`   static_env: ${Object.entries(e.staticEnv).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
  }
  return { exitCode: 0 };
}

/** Raw, unvalidated CLI flag values — `collectMcpAddPlan` does the actual
 * parsing/validation. Kept as plain strings here so `parseMcpAddArgs`
 * stays a dumb `--flag value` reader, same posture as every other
 * command's own inline flag parsing in src/cli.ts. */
export interface McpAddRawArgs {
  transport?: string;
  auth?: string;
  command?: string;
  /** Comma-separated. */
  args?: string;
  url?: string;
  /** Comma-separated `k=v` pairs. */
  headers?: string;
  /** Comma-separated names. */
  env?: string;
  /** Comma-separated `k=v` pairs. */
  staticEnv?: string;
  /** Comma-separated agent ids. */
  agents?: string;
  /** `"true"` or `"false"`. */
  enabled?: string;
}

export function parseMcpAddArgs(argv: readonly string[]): McpAddRawArgs {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    transport: flag("--transport"),
    auth: flag("--auth"),
    command: flag("--command"),
    args: flag("--args"),
    url: flag("--url"),
    headers: flag("--headers"),
    env: flag("--env"),
    staticEnv: flag("--static-env"),
    agents: flag("--agents"),
    enabled: flag("--enabled"),
  };
}

function parseCsv(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseKvList(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const TRANSPORTS: readonly Transport[] = ["stdio", "http", "sse"];

export type McpAddAction = "create" | "already-present" | "conflict" | "invalid-input";

export interface McpAddPlan {
  name: string;
  action: McpAddAction;
  detail: string;
  /** Only set when action === "create"; consumed by applyMcpAddPlan. */
  def?: McpServerDef;
}

/**
 * Validates transport-specific required flags at this layer (stdio needs
 * `--command`, http/sse need `--url`) rather than deferring to a later
 * write failure — design.md's open question, resolved in favor of
 * refusing early with a specific reason. No `--force`: an existing name
 * always refuses, ever (design.md D4).
 */
export function collectMcpAddPlan(name: string | undefined, raw: McpAddRawArgs, homeDir: string = homedir()): McpAddPlan {
  if (!name) {
    return { name: "(none)", action: "invalid-input", detail: "a name is required: trellis mcp add <name> --transport ..." };
  }
  if (!raw.transport || !(TRANSPORTS as readonly string[]).includes(raw.transport)) {
    return { name, action: "invalid-input", detail: `--transport must be one of: ${TRANSPORTS.join(", ")}` };
  }
  const transport = raw.transport as Transport;

  if (transport === "stdio" && !raw.command) {
    return { name, action: "invalid-input", detail: "--transport stdio requires --command" };
  }
  if ((transport === "http" || transport === "sse") && !raw.url) {
    return { name, action: "invalid-input", detail: `--transport ${transport} requires --url` };
  }
  if (raw.auth !== undefined && raw.auth !== "oauth") {
    return { name, action: "invalid-input", detail: `--auth must be "oauth" when provided (got ${raw.auth})` };
  }
  if (raw.auth === "oauth" && transport === "stdio") {
    return { name, action: "invalid-input", detail: "--auth oauth requires an http or sse MCP server" };
  }

  const agentsList = parseCsv(raw.agents);
  if (agentsList) {
    for (const id of agentsList) {
      if (!(ALL_AGENTS as readonly string[]).includes(id)) {
        return { name, action: "invalid-input", detail: `--agents "${id}" is not a recognized agent id (${ALL_AGENTS.join(", ")})` };
      }
    }
  }
  if (raw.enabled !== undefined && raw.enabled !== "true" && raw.enabled !== "false") {
    return { name, action: "invalid-input", detail: `--enabled must be "true" or "false" (got ${raw.enabled})` };
  }

  const def: McpServerDef = {
    transport,
    ...(raw.auth === "oauth" ? { auth: "oauth" as const } : {}),
    ...(raw.command ? { command: raw.command } : {}),
    ...(parseCsv(raw.args) ? { args: parseCsv(raw.args) } : {}),
    ...(raw.url ? { url: raw.url } : {}),
    ...(parseKvList(raw.headers) ? { headers: parseKvList(raw.headers) } : {}),
    ...(parseCsv(raw.env) ? { env: parseCsv(raw.env) } : {}),
    ...(parseKvList(raw.staticEnv) ? { staticEnv: parseKvList(raw.staticEnv) } : {}),
    ...(raw.enabled !== undefined ? { enabled: raw.enabled === "true" } : {}),
    ...(agentsList ? { agents: agentsList as AgentId[] } : {}),
  };

  const canonical = loadCanonicalSource(homeDir);
  const existing = canonical.mcp.servers[name];
  if (existing) {
    if (JSON.stringify(existing) === JSON.stringify(def)) {
      return { name, action: "already-present", detail: "canonical entry is already identical" };
    }
    return { name, action: "conflict", detail: `servers.yaml already has "${name}" with different settings — resolve by hand (no --force, design.md D4)` };
  }

  return { name, action: "create", detail: "will add to servers.yaml", def };
}

export type McpSetAuthAction = "updated" | "already-set" | "not-found" | "invalid-input";

export interface McpSetAuthPlan {
  name: string;
  auth: "oauth" | "none";
  action: McpSetAuthAction;
  detail: string;
  def?: McpServerDef;
}

export function collectMcpSetAuthPlan(name: string | undefined, auth: string | undefined, homeDir: string = homedir()): McpSetAuthPlan {
  const mode = auth === "oauth" || auth === "none" ? auth : undefined;
  if (!name) return { name: "(none)", auth: (mode ?? "none"), action: "invalid-input", detail: "usage: trellis mcp set <name> --auth oauth|none" };
  if (!mode) return { name, auth: "none", action: "invalid-input", detail: `--auth must be "oauth" or "none" (got ${auth ?? "(missing)"})` };
  const canonical = loadCanonicalSource(homeDir);
  const current = canonical.mcp.servers[name];
  if (!current) return { name, auth: mode, action: "not-found", detail: `no canonical MCP server named "${name}"` };
  if (mode === "oauth" && !current.url) {
    return { name, auth: mode, action: "invalid-input", detail: "auth: oauth requires an http or sse MCP server" };
  }
  const next = mode === "oauth" ? { ...current, auth: "oauth" as const } : (() => {
    const { auth: _auth, ...withoutAuth } = current;
    return withoutAuth;
  })();
  if (JSON.stringify(current) === JSON.stringify(next)) return { name, auth: mode, action: "already-set", detail: `auth is already ${mode}`, def: next };
  return { name, auth: mode, action: "updated", detail: `set auth to ${mode}`, def: next };
}

export function runMcpSetAuth(name: string | undefined, auth: string | undefined, opts: { homeDir?: string; json?: boolean; dryRun?: boolean } = {}): { exitCode: number } {
  const homeDir = opts.homeDir ?? homedir();
  let plan: McpSetAuthPlan;
  try {
    plan = collectMcpSetAuthPlan(name, auth, homeDir);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }
  let writeError: string | undefined;
  if (!opts.dryRun && plan.action === "updated" && plan.def) {
    const result = upsertServerYaml(serversYamlPath(homeDir), plan.name, plan.def);
    if (!result.ok) writeError = result.error;
  }
  if (opts.json) {
    console.log(JSON.stringify(writeError ? { ...plan, writeError } : plan, null, 2));
  } else {
    console.log(`${opts.dryRun ? "[dry run] " : ""}mcp set ${plan.name}`);
    console.log(`  [${plan.action}] ${plan.detail}`);
    if (writeError) console.error(`  write failed: ${writeError}`);
  }
  return { exitCode: ["invalid-input", "not-found"].includes(plan.action) || Boolean(writeError) ? 1 : 0 };
}

export function applyMcpAddPlan(plan: McpAddPlan, homeDir: string = homedir()): ServersYamlWriteResult {
  if (plan.action !== "create" || !plan.def) return { ok: true };
  return upsertServerYaml(serversYamlPath(homeDir), plan.name, plan.def);
}

export async function runMcpAdd(name: string | undefined, raw: McpAddRawArgs, opts: { homeDir?: string; json?: boolean; dryRun?: boolean } = {}): Promise<{ exitCode: number }> {
  const homeDir = opts.homeDir ?? homedir();
  let plan: McpAddPlan;
  try {
    plan = collectMcpAddPlan(name, raw, homeDir);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }

  let writeError: string | undefined;
  if (!opts.dryRun && plan.action === "create") {
    const result = applyMcpAddPlan(plan, homeDir);
    if (!result.ok) writeError = result.error;
  }

  const planFailed = plan.action === "conflict" || plan.action === "invalid-input" || Boolean(writeError);
  let syncReport: McpSyncReport | undefined;
  if (!planFailed && plan.action === "create" && existsSync(join(homeDir, ".trellis"))) {
    try {
      syncReport = await collectMcpSyncReport({ homeDir, dryRun: opts.dryRun });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return { exitCode: 1 };
    }
  }

  if (opts.json) {
    const payload = writeError ? { ...plan, writeError } : plan;
    console.log(JSON.stringify(syncReport ? { ...payload, sync: syncReport } : payload, null, 2));
  } else {
    console.log(`${opts.dryRun ? "[dry run] " : ""}mcp add ${plan.name}`);
    console.log(`  [${plan.action}] ${plan.detail}`);
    if (writeError) console.error(`  write failed: ${writeError}`);
    if (syncReport) printReport(syncReport, opts.dryRun ?? false);
  }
  const syncConflict = syncReport?.reports.some((r) => r.items.some((i) => i.action === "conflict")) ?? false;
  return { exitCode: planFailed || syncConflict ? 1 : 0 };
}

export type McpRemoveAction = "removed" | "not-found";

export interface McpRemovePlan {
  name: string;
  action: McpRemoveAction;
}

/** Canonical plan only — `runMcpRemove` follows a real removal with the
 * same sync `mcp sync` performs, which propagates the deletion to every
 * agent whose entry the ownership ledger proves Trellis wrote
 * (trellis-mcp-lifecycle-parity, roadmap P14). */
export function collectMcpRemovePlan(name: string, homeDir: string = homedir()): McpRemovePlan {
  const canonical = loadCanonicalSource(homeDir);
  return { name, action: canonical.mcp.servers[name] ? "removed" : "not-found" };
}

export function applyMcpRemovePlan(plan: McpRemovePlan, homeDir: string = homedir()): ServersYamlWriteResult {
  if (plan.action !== "removed") return { ok: true };
  return removeServerYaml(serversYamlPath(homeDir), plan.name);
}

export async function runMcpRemove(name: string, opts: { homeDir?: string; json?: boolean; dryRun?: boolean } = {}): Promise<{ exitCode: number }> {
  const homeDir = opts.homeDir ?? homedir();
  let plan: McpRemovePlan;
  try {
    plan = collectMcpRemovePlan(name, homeDir);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }

  let writeError: string | undefined;
  if (!opts.dryRun && plan.action === "removed") {
    const result = applyMcpRemovePlan(plan, homeDir);
    if (!result.ok) writeError = result.error;
  }

  const planFailed = plan.action === "not-found" || Boolean(writeError);
  let syncReport: McpSyncReport | undefined;
  if (!planFailed && existsSync(join(homeDir, ".trellis"))) {
    try {
      syncReport = await collectMcpSyncReport({ homeDir, dryRun: opts.dryRun });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return { exitCode: 1 };
    }
  }

  if (opts.json) {
    const payload = writeError ? { ...plan, writeError } : plan;
    console.log(JSON.stringify(syncReport ? { ...payload, sync: syncReport } : payload, null, 2));
  } else if (plan.action === "not-found") {
    console.error(`"${name}" is not a canonical MCP server — nothing to remove.`);
  } else if (writeError) {
    console.error(`  write failed: ${writeError}`);
  } else {
    console.log(`${opts.dryRun ? "[dry run] " : ""}removed MCP server "${name}" from canonical source.`);
    if (syncReport) printReport(syncReport, opts.dryRun ?? false);
  }
  const syncConflict = syncReport?.reports.some((r) => r.items.some((i) => i.action === "conflict")) ?? false;
  return { exitCode: planFailed || syncConflict ? 1 : 0 };
}
