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
import { ALL_AGENTS, isOAuthAuth, oauthClientMetadata, resolveScope } from "../core/types.js";
import type { AgentId, McpAuthMode, McpConfig, McpServerDef, Transport } from "../core/types.js";
import { isValidSecretVarName } from "../lib/secretEnv.js";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { CodexAdapter } from "../adapters/codex.js";
import { KiroAdapter } from "../adapters/kiro.js";
import { PiAdapter } from "../adapters/pi.js";
import { KimiCodeAdapter } from "../adapters/kimi-code.js";
import { ZcodeAdapter } from "../adapters/zcode.js";
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
  zcode: (homeDir) => new ZcodeAdapter(homeDir),
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
  /** Normalized: `oauth` in either the scalar or the object form reports as
   * the scalar here — the listing reports classification, not metadata. */
  auth?: McpAuthMode;
  /** Presence of pre-registered client metadata
   * (trellis-mcp-oauth-static-client task 3.2) — `true` when the object form
   * carries a `client_id`. A presence flag, deliberately not the id itself:
   * the id is public-by-design, but listing output stays stable if that
   * ever changes and there is one less place a future secret-looking field
   * could leak through. */
  preRegisteredClient?: true;
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
    auth: isOAuthAuth(def.auth) ? ("oauth" as const) : undefined,
    preRegisteredClient: oauthClientMetadata(def.auth).clientId !== undefined ? (true as const) : undefined,
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
      console.log(`${e.name} (${e.transport}${e.auth === "oauth" ? ", oauth" : ""}${e.preRegisteredClient ? ", pre-registered client" : ""})${e.enabled ? "" : " [disabled]"} — ${scope}`);
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

export function parseMcpSetArgs(argv: readonly string[]): McpSetAuthRawArgs {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    auth: flag("--auth"),
    clientId: flag("--client-id"),
    clientSecretEnv: flag("--client-secret-env"),
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

/** Raw, unvalidated CLI flag values for `mcp set` — same posture as
 * `McpAddRawArgs`: the parser stays a dumb reader, validation lives in the
 * plan collector. */
export interface McpSetAuthRawArgs {
  auth?: string;
  /** Public literal by design (design.md D2) — the one field it is fine to
   * pass on a command line. Never echoed back in output or errors. */
  clientId?: string;
  /** A variable NAME, never a secret value. */
  clientSecretEnv?: string;
}

/**
 * Sets or clears the OAuth classification, and optionally the
 * pre-registered client metadata that goes with it
 * (trellis-mcp-oauth-static-client tasks.md 3.1).
 *
 * Three rules the flag interaction has to get right:
 *   - A bare `--auth oauth` is a re-classification, not a reset: an entry
 *     that already carries a `client_id` keeps it. Silently dropping
 *     metadata here would turn "make sure this is OAuth" into "break my
 *     Figma setup", which is exactly the kind of invisible precedence
 *     `mcp set` exists to avoid.
 *   - `--auth none` is the reset — it strips the whole `auth` key,
 *     metadata included, because that is the only reading of "none" that
 *     leaves the file in a self-consistent state.
 *   - `--client-id` / `--client-secret-env` require an explicit
 *     `--auth oauth` in the same invocation. Implying it would make a
 *     typo'd flag name mutate the classification.
 */
export function collectMcpSetAuthPlan(name: string | undefined, raw: McpSetAuthRawArgs, homeDir: string = homedir()): McpSetAuthPlan {
  const mode = raw.auth === "oauth" || raw.auth === "none" ? raw.auth : undefined;
  if (!name) return { name: "(none)", auth: (mode ?? "none"), action: "invalid-input", detail: "usage: trellis mcp set <name> --auth oauth|none [--client-id <id>] [--client-secret-env <NAME>]" };

  const hasClientFlags = raw.clientId !== undefined || raw.clientSecretEnv !== undefined;
  const clientFlagsDetail = "--client-id / --client-secret-env require an explicit --auth oauth in the same command";
  if (mode === undefined) {
    // Naming the missing --auth is the actionable error when that is what
    // the user was reaching for; otherwise report the invalid value itself.
    if (hasClientFlags) return { name, auth: "none", action: "invalid-input", detail: clientFlagsDetail };
    return { name, auth: "none", action: "invalid-input", detail: `--auth must be "oauth" or "none" (got ${raw.auth ?? "(missing)"})` };
  }
  if (hasClientFlags && mode !== "oauth") {
    return { name, auth: mode, action: "invalid-input", detail: clientFlagsDetail };
  }
  if (raw.clientId === "") {
    return { name, auth: mode, action: "invalid-input", detail: "--client-id must not be empty" };
  }
  if (raw.clientSecretEnv !== undefined && !isValidSecretVarName(raw.clientSecretEnv)) {
    // The value is deliberately not echoed: a name-shaped field failing
    // this check is at best a typo and at worst a pasted credential
    // (design.md D2).
    return {
      name,
      auth: mode,
      action: "invalid-input",
      detail: "--client-secret-env must be a variable NAME (e.g. FIGMA_CLIENT_SECRET), never a secret value",
    };
  }

  const canonical = loadCanonicalSource(homeDir);
  const current = canonical.mcp.servers[name];
  if (!current) return { name, auth: mode, action: "not-found", detail: `no canonical MCP server named "${name}"` };
  if (mode === "oauth" && !current.url) {
    return { name, auth: mode, action: "invalid-input", detail: "auth: oauth requires an http or sse MCP server" };
  }

  // Same load-time guard as `assertAuthMetadataClean`, applied at write
  // time so an offending value never reaches the file in the first place.
  const offending = [
    ["client-id", raw.clientId],
    ["client-secret-env", raw.clientSecretEnv],
  ].find(([, value]) => value !== undefined && canonical.secretsPolicy.rejectPatterns.some((pattern) => pattern.test(value)));
  if (offending) {
    return {
      name,
      auth: mode,
      action: "invalid-input",
      detail: `--${offending[0]} matches a secrets.policy.yaml reject pattern — client-id must be the provider-published id, client-secret-env a variable name; the offending value is intentionally not printed`,
    };
  }

  let next: McpServerDef;
  if (mode === "none") {
    const { auth: _auth, ...withoutAuth } = current;
    next = withoutAuth;
  } else if (!hasClientFlags && isOAuthAuth(current.auth)) {
    // Already classified and no new metadata: a true no-op. Rewriting the
    // scalar into a metadata-less object here would churn the file to say
    // exactly what it already said (design.md D1 makes them equivalent).
    next = current;
  } else if (!hasClientFlags) {
    // Newly classified, nothing to record — the scalar is the documented
    // shorthand, so write the smaller of two equivalent forms.
    next = { ...current, auth: "oauth" };
  } else {
    const existing = oauthClientMetadata(current.auth);
    // Per-field override, not replacement: `--client-id` alone keeps a
    // `client_secret_env` that is already configured.
    const clientId = raw.clientId ?? existing.clientId;
    const clientSecretEnv = raw.clientSecretEnv ?? existing.clientSecretEnv;
    next = {
      ...current,
      auth: {
        kind: "oauth",
        ...(clientId !== undefined ? { clientId } : {}),
        ...(clientSecretEnv !== undefined ? { clientSecretEnv } : {}),
      },
    };
  }

  if (JSON.stringify(current) === JSON.stringify(next)) return { name, auth: mode, action: "already-set", detail: `auth is already ${mode}`, def: next };
  const changed = hasClientFlags ? " and client metadata" : "";
  return { name, auth: mode, action: "updated", detail: `set auth to ${mode}${changed}`, def: next };
}

export function runMcpSetAuth(name: string | undefined, raw: McpSetAuthRawArgs, opts: { homeDir?: string; json?: boolean; dryRun?: boolean } = {}): { exitCode: number } {
  const homeDir = opts.homeDir ?? homedir();
  let plan: McpSetAuthPlan;
  try {
    plan = collectMcpSetAuthPlan(name, raw, homeDir);
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

export function applyMcpAddPlan(plan: McpAddPlan, homeDir: string = homedir(), backup?: BackupSession): ServersYamlWriteResult {
  if (plan.action !== "create" || !plan.def) return { ok: true };
  return upsertServerYaml(serversYamlPath(homeDir), plan.name, plan.def, backup);
}

export interface McpAddOutcome {
  plan: McpAddPlan;
  writeError?: string;
  sync?: McpSyncReport;
}

/**
 * The apply-and-cascade-sync orchestration `runMcpAdd` used to do inline
 * and only expose via a console.log'd payload — split out so a
 * non-CLI caller (trellis-gui's sidecar) can get the same structured
 * result a JSON-mode CLI run prints, without scraping stdout or
 * re-deriving the same sequencing itself (trellis-gui design.md
 * Decision 1). Behavior-preserving: `runMcpAdd` below is now a thin
 * wrapper over this plus its own printing, same as every other command
 * in this file already splits compute from CLI I/O.
 *
 * Opens its own backup session around the direct `servers.yaml` write
 * when the caller doesn't already have one open — this canonical write
 * used to be the one path in this file that bypassed backup/rollback
 * entirely (trellis-gui tasks.md 3.5 found this empirically: a real `mcp
 * add` left zero trace in `trellis rollback --list`). Mirrors the
 * `ownSession` pattern `collectMcpSyncReport` below already uses for
 * exactly the same reason.
 */
export async function applyMcpAddWithSync(plan: McpAddPlan, opts: { homeDir?: string; dryRun?: boolean; backupSession?: BackupSession } = {}): Promise<McpAddOutcome> {
  const homeDir = opts.homeDir ?? homedir();
  const ownSession = !opts.dryRun && !opts.backupSession && plan.action === "create" ? openBackupSession(homeDir, "mcp-add") : undefined;
  const session = opts.backupSession ?? ownSession;
  let writeError: string | undefined;
  if (!opts.dryRun && plan.action === "create") {
    const result = applyMcpAddPlan(plan, homeDir, session);
    if (!result.ok) writeError = result.error;
  }
  ownSession?.finalize();
  const planFailed = plan.action === "conflict" || plan.action === "invalid-input" || Boolean(writeError);
  let syncReport: McpSyncReport | undefined;
  if (!planFailed && plan.action === "create" && existsSync(join(homeDir, ".trellis"))) {
    syncReport = await collectMcpSyncReport({ homeDir, dryRun: opts.dryRun });
  }
  return { plan, ...(writeError ? { writeError } : {}), ...(syncReport ? { sync: syncReport } : {}) };
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

  let outcome: McpAddOutcome;
  try {
    outcome = await applyMcpAddWithSync(plan, { homeDir, dryRun: opts.dryRun });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }
  const { writeError, sync: syncReport } = outcome;

  if (opts.json) {
    const payload = writeError ? { ...plan, writeError } : plan;
    console.log(JSON.stringify(syncReport ? { ...payload, sync: syncReport } : payload, null, 2));
  } else {
    console.log(`${opts.dryRun ? "[dry run] " : ""}mcp add ${plan.name}`);
    console.log(`  [${plan.action}] ${plan.detail}`);
    if (writeError) console.error(`  write failed: ${writeError}`);
    if (syncReport) printReport(syncReport, opts.dryRun ?? false);
  }
  const planFailed = plan.action === "conflict" || plan.action === "invalid-input" || Boolean(writeError);
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

export function applyMcpRemovePlan(plan: McpRemovePlan, homeDir: string = homedir(), backup?: BackupSession): ServersYamlWriteResult {
  if (plan.action !== "removed") return { ok: true };
  return removeServerYaml(serversYamlPath(homeDir), plan.name, backup);
}

export interface McpRemoveOutcome {
  plan: McpRemovePlan;
  writeError?: string;
  sync?: McpSyncReport;
}

/** See `applyMcpAddWithSync`'s doc comment — same split, same reason, same
 * own-backup-session fix. */
export async function applyMcpRemoveWithSync(plan: McpRemovePlan, opts: { homeDir?: string; dryRun?: boolean; backupSession?: BackupSession } = {}): Promise<McpRemoveOutcome> {
  const homeDir = opts.homeDir ?? homedir();
  const ownSession = !opts.dryRun && !opts.backupSession && plan.action === "removed" ? openBackupSession(homeDir, "mcp-remove") : undefined;
  const session = opts.backupSession ?? ownSession;
  let writeError: string | undefined;
  if (!opts.dryRun && plan.action === "removed") {
    const result = applyMcpRemovePlan(plan, homeDir, session);
    if (!result.ok) writeError = result.error;
  }
  ownSession?.finalize();
  const planFailed = plan.action === "not-found" || Boolean(writeError);
  let syncReport: McpSyncReport | undefined;
  if (!planFailed && existsSync(join(homeDir, ".trellis"))) {
    syncReport = await collectMcpSyncReport({ homeDir, dryRun: opts.dryRun });
  }
  return { plan, ...(writeError ? { writeError } : {}), ...(syncReport ? { sync: syncReport } : {}) };
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

  let outcome: McpRemoveOutcome;
  try {
    outcome = await applyMcpRemoveWithSync(plan, { homeDir, dryRun: opts.dryRun });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }
  const { writeError, sync: syncReport } = outcome;
  const planFailed = plan.action === "not-found" || Boolean(writeError);

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
