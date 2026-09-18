/**
 * Loads `~/.trellis/` into a `CanonicalSource`. Global only — no `root`
 * parameter, no workspace merge (docs/architecture.md "Global vs.
 * workspace scope"). See openspec/changes/trellis-sync-p1/specs/
 * canonical-source-loading/spec.md for the exact contract this implements.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isMap, isSeq, parse as parseYaml, parseDocument } from "yaml";
import type { AgentId, AgentProfile, CapabilityDelivery, CanonicalSource, GatewayConfig, McpConfig, McpRoute, McpRouteMode, McpRuntimeConfig, McpServerDef, MemoryEntry, Scope, SecretsPolicy, SkillRef } from "./types.js";
import { ALL_AGENTS } from "./types.js";
import type { BackupSession } from "../lib/backup.js";

interface ScopeYaml {
  skills?: Record<string, AgentId[]>;
  agents?: Record<string, AgentId[]>;
  memories?: Record<string, AgentId[]>;
}

/**
 * The on-disk shape for one server entry — `static_env`/`env_aliases`
 * (snake_case, like every other multi-word key across `.trellis/*.yaml`)
 * are translated to `McpServerDef.staticEnv`/`envAliases` (camelCase)
 * below; every other field happens to already be a single word, so no
 * server-def field needed this treatment before
 * (trellis-mcp-static-env-and-disabled-servers, trellis-migrate-env-var-alias).
 */
type McpServerDefYaml = Omit<McpServerDef, "staticEnv" | "envAliases"> & { static_env?: Record<string, string>; env_aliases?: Record<string, string> };

interface ServersYaml {
  servers?: Record<string, McpServerDefYaml>;
  known_host_injected?: string[];
  hub?: { url: string };
  gateway?: { enabled?: boolean; agents?: AgentId[] };
  routes?: Partial<Record<string, { mode?: McpRouteMode; servers?: string[] }>>;
  runtime?: { delivery?: Partial<Record<string, CapabilityDelivery>> };
}

function fromServerDefYaml(def: McpServerDefYaml): McpServerDef {
  const { static_env, env_aliases, ...rest } = def;
  const out: McpServerDef = { ...rest };
  if (static_env) out.staticEnv = static_env;
  if (env_aliases) out.envAliases = env_aliases;
  return out;
}

/** Inverse of `fromServerDefYaml` (trellis-canonical-cli-crud) — strips
 * `undefined` fields so the written YAML never gets a literal `null`
 * for an omitted optional. */
export function toServerDefYaml(def: McpServerDef): McpServerDefYaml {
  const { staticEnv, envAliases, ...rest } = def;
  const out: Record<string, unknown> = { ...rest };
  if (staticEnv) out.static_env = staticEnv;
  if (envAliases) out.env_aliases = envAliases;
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key];
  }
  return out as McpServerDefYaml;
}

interface SecretsPolicyYaml {
  allowed_vars?: string[];
  reject_patterns?: string[];
  env_file?: string;
}

interface ManagedYaml {
  agents?: string[];
}

function trellisRoot(homeDir: string): string {
  return join(homeDir, ".trellis");
}

function listMarkdownFiles(dir: string): { name: string; file: string }[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({ name: basename(name, ".md"), file: join(dir, name) }));
}

function listSkillDirs(dir: string): { name: string; dir: string }[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const skills: { name: string; dir: string }[] = [];
  for (const name of entries) {
    const skillDir = join(dir, name);
    try {
      if (statSync(skillDir).isDirectory()) {
        skills.push({ name, dir: skillDir });
      }
    } catch {
      // unreadable/broken entry — skip, not a load failure
    }
  }
  return skills;
}

function loadScopeYaml(path: string): ScopeYaml {
  if (!existsSync(path)) {
    return {};
  }
  const parsed = parseYaml(readFileSync(path, "utf-8"));
  return (parsed ?? {}) as ScopeYaml;
}

function loadServersYaml(path: string): McpConfig {
  if (!existsSync(path)) {
    return { servers: {}, knownHostInjected: [] };
  }
  const parsed = (parseYaml(readFileSync(path, "utf-8")) ?? {}) as ServersYaml;
  const servers = Object.fromEntries(Object.entries(parsed.servers ?? {}).map(([name, def]) => [name, fromServerDefYaml(def)]));
  return {
    servers,
    knownHostInjected: parsed.known_host_injected ?? [],
    hub: parsed.hub,
    gateway: fromGatewayYaml(parsed.gateway),
    routes: fromRoutesYaml(parsed.routes),
    runtime: fromRuntimeYaml(parsed.runtime),
  };
}

function fromRuntimeYaml(runtime: ServersYaml["runtime"]): McpRuntimeConfig | undefined {
  if (!runtime?.delivery) return undefined;
  const delivery: Partial<Record<AgentId, CapabilityDelivery>> = {};
  for (const [rawAgent, rawDelivery] of Object.entries(runtime.delivery)) {
    if (!(ALL_AGENTS as readonly string[]).includes(rawAgent)) continue;
    if (rawDelivery !== "native" && rawDelivery !== "mcp" && rawDelivery !== "both") continue;
    delivery[rawAgent as AgentId] = rawDelivery;
  }
  return Object.keys(delivery).length > 0 ? { delivery } : undefined;
}

function fromRoutesYaml(routes: ServersYaml["routes"]): Partial<Record<AgentId, McpRoute>> | undefined {
  if (!routes) return undefined;
  const out: Partial<Record<AgentId, McpRoute>> = {};
  for (const [rawAgent, rawRoute] of Object.entries(routes)) {
    if (!(ALL_AGENTS as readonly string[]).includes(rawAgent)) continue;
    if (!rawRoute?.mode || !["direct", "gateway", "hub"].includes(rawRoute.mode)) continue;
    out[rawAgent as AgentId] = {
      mode: rawRoute.mode,
      ...(rawRoute.servers ? { servers: rawRoute.servers } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A `gateway:` block with no `enabled` key reads as off, not as on — the
 * only safe default for a field whose whole effect is to stop writing the
 * per-server entries an agent is currently working with. Absent entirely,
 * the field stays `undefined` so `resolveMcpPlan` can tell "never
 * configured" from "explicitly disabled" if that ever matters.
 */
function fromGatewayYaml(gateway: ServersYaml["gateway"]): GatewayConfig | undefined {
  if (!gateway) return undefined;
  const out: GatewayConfig = { enabled: gateway.enabled === true };
  if (gateway.agents) out.agents = gateway.agents;
  return out;
}

export type ServersYamlWriteResult = { ok: true } | { ok: false; error: string };

/**
 * Writes or replaces one server entry in `servers.yaml`, preserving
 * every other entry's and comment's exact formatting (trellis-
 * canonical-cli-crud design.md D3) — a `Document`-based edit
 * (`setIn`), never `parse` + rebuild + `stringify`, which would
 * re-serialize the whole file and lose anything hand-authored outside
 * the touched entry. Refuses (no write) if the file doesn't exist yet
 * (run `trellis init` first) or fails to parse.
 */
/**
 * `trellis init`'s starter `servers.yaml` writes `servers: {}` — an empty
 * flow-style map, since there's nothing to indent yet. `Document#setIn`
 * inserting into an *existing* flow map keeps rendering it as flow, so
 * the first `mcp add`/`migrate --only mcp` onto a fresh file — and every
 * one after it — would render as one unreadable line (found via actually
 * running the CLI against a fresh `init`, not by inspection). Forcing the
 * touched map, and the newly-set entry's own map, to block style is a
 * one-line, local fix — it never touches any sibling entry's own style,
 * so a file someone deliberately kept flow-style elsewhere is untouched.
 */
/** Handles both a map (`servers: {}`) and a sequence (`allowed_vars: []`)
 * — `trellis init`'s starter files use flow style for both kinds of
 * still-empty collection, and inserting into either one via `Document`
 * methods keeps rendering it as flow otherwise (same real bug this
 * function was first written to fix, just a second collection type
 * hitting it — trellis-migrate-extract-static-env-secrets). */
function forceBlockStyle(node: unknown): void {
  if (isMap(node) || isSeq(node)) {
    node.flow = false;
  }
}

function persistText(path: string, content: string, backup?: BackupSession): void {
  if (existsSync(path) && readFileSync(path, "utf-8") === content) return;
  if (backup) backup.writeFile(path, content);
  else writeFileSync(path, content);
}

export function upsertServerYaml(path: string, name: string, def: McpServerDef, backup?: BackupSession): ServersYamlWriteResult {
  if (!existsSync(path)) {
    return { ok: false, error: `${path} does not exist — run \`trellis init\` first` };
  }
  let doc;
  try {
    doc = parseDocument(readFileSync(path, "utf-8"));
  } catch (err) {
    return { ok: false, error: `could not parse ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  doc.setIn(["servers", name], toServerDefYaml(def));
  forceBlockStyle(doc.get("servers", true));
  forceBlockStyle(doc.getIn(["servers", name], true));
  persistText(path, doc.toString(), backup);
  return { ok: true };
}

/** Inverse of `upsertServerYaml` — same preservation guarantee, same
 * refusal posture on a missing/unparseable file. */
export function removeServerYaml(path: string, name: string, backup?: BackupSession): ServersYamlWriteResult {
  if (!existsSync(path)) {
    return { ok: false, error: `${path} does not exist — run \`trellis init\` first` };
  }
  let doc;
  try {
    doc = parseDocument(readFileSync(path, "utf-8"));
  } catch (err) {
    return { ok: false, error: `could not parse ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  doc.deleteIn(["servers", name]);
  persistText(path, doc.toString(), backup);
  return { ok: true };
}

/**
 * `trellis onboard --mcp-mode <value>` (trellis-onboard-mcp-mode) —
 * everything needed to select or clear the top-level `hub`/`gateway`
 * mode fields, mutually exclusive by construction (design.md D3): a
 * `"direct"` mode carries nothing to set, only two keys to clear.
 */
export type McpMode = { kind: "direct" } | { kind: "hub"; url: string } | { kind: "gateway"; agents?: AgentId[] };

/**
 * Sets or clears `servers.yaml`'s top-level `hub`/`gateway` keys — the
 * write path `upsertServerYaml`/`removeServerYaml` don't cover, since
 * both are scoped to one `servers` entry (design.md D2). Same
 * `Document`-based mechanism, same refusal posture on a missing or
 * unparseable file, same `forceBlockStyle` correction for a key set for
 * the first time into a still-flow-style document (`trellis init`'s
 * starter file). Selecting one mode always clears the other two
 * (design.md D3) — never left for the caller to remember.
 */
export function writeMcpModeYaml(path: string, mode: McpMode, backup?: BackupSession): ServersYamlWriteResult {
  if (!existsSync(path)) {
    return { ok: false, error: `${path} does not exist — run \`trellis init\` first` };
  }
  let doc;
  try {
    doc = parseDocument(readFileSync(path, "utf-8"));
  } catch (err) {
    return { ok: false, error: `could not parse ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  switch (mode.kind) {
    case "direct":
      doc.delete("hub");
      doc.delete("gateway");
      break;
    case "hub":
      doc.setIn(["hub", "url"], mode.url);
      doc.delete("gateway");
      forceBlockStyle(doc.get("hub", true));
      break;
    case "gateway":
      doc.setIn(["gateway", "enabled"], true);
      if (mode.agents !== undefined) {
        doc.setIn(["gateway", "agents"], mode.agents);
      } else {
        doc.deleteIn(["gateway", "agents"]);
      }
      doc.delete("hub");
      forceBlockStyle(doc.get("gateway", true));
      break;
  }
  persistText(path, doc.toString(), backup);
  return { ok: true };
}

export type McpRoutesWriteResult = ServersYamlWriteResult;

/** Writes explicit per-agent routes while preserving legacy hub/gateway
 * shorthand. An empty route map removes the optional key. */
export function writeMcpRoutesYaml(path: string, routes: Partial<Record<AgentId, McpRoute>>, backup?: BackupSession): McpRoutesWriteResult {
  if (!existsSync(path)) {
    return { ok: false, error: `${path} does not exist — run \`trellis init\` first` };
  }
  let doc;
  try {
    doc = parseDocument(readFileSync(path, "utf-8"));
  } catch (err) {
    return { ok: false, error: `could not parse ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const serialized = Object.fromEntries(
    Object.entries(routes).map(([agent, route]) => [agent, { mode: route.mode, ...(route.servers ? { servers: route.servers } : {}) }]),
  );
  if (Object.keys(serialized).length === 0) {
    doc.delete("routes");
  } else {
    doc.set("routes", serialized);
    forceBlockStyle(doc.get("routes", true));
  }
  persistText(path, doc.toString(), backup);
  return { ok: true };
}

/** Writes per-agent capability delivery preferences into servers.yaml.
 * Omitted entries continue to use the native default. */
export function writeMcpRuntimeDeliveryYaml(path: string, delivery: Partial<Record<AgentId, CapabilityDelivery>>, backup?: BackupSession): ServersYamlWriteResult {
  if (!existsSync(path)) {
    return { ok: false, error: path + " does not exist — run trellis init first" };
  }
  let doc;
  try {
    doc = parseDocument(readFileSync(path, "utf-8"));
  } catch (err) {
    return { ok: false, error: `could not parse ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const serialized = Object.fromEntries(
    Object.entries(delivery).map(([agent, mode]) => [agent, mode]),
  );
  if (Object.keys(serialized).length === 0) {
    doc.delete("runtime");
  } else {
    doc.setIn(["runtime", "delivery"], serialized);
    forceBlockStyle(doc.get("runtime", true));
    forceBlockStyle(doc.getIn(["runtime", "delivery"], true));
  }
  persistText(path, doc.toString(), backup);
  return { ok: true };
}

function loadSecretsPolicyYaml(path: string, homeDir: string): SecretsPolicy {
  if (!existsSync(path)) {
    return { allowedVars: [], rejectPatterns: [] };
  }
  const parsed = (parseYaml(readFileSync(path, "utf-8")) ?? {}) as SecretsPolicyYaml;
  return {
    allowedVars: parsed.allowed_vars ?? [],
    rejectPatterns: (parsed.reject_patterns ?? []).map((pattern) => new RegExp(pattern)),
    envFile: parsed.env_file ? parsed.env_file.replace(/^~(?=$|\/)/, homeDir) : undefined,
  };
}

export type SecretsPolicyWriteResult = { ok: true } | { ok: false; error: string };

/**
 * `trellis migrate`'s static-env secret extraction
 * (trellis-migrate-extract-static-env-secrets design.md D6) — the
 * missing writer for `secrets.policy.yaml`, mirroring `writeMcpModeYaml`'s
 * `Document`-based, comment-preserving mechanism. Sets `env_file` only
 * when it is not already set — an already-configured value is a
 * deliberate prior choice (design.md D3) and `resolveSecretEnv` treats
 * `env_file` as the sole source once set, so silently repointing it
 * would orphan every name already resolving from the old file. Appends
 * `varName` to `allowed_vars` only if not already present (dedup, same
 * "already there is a no-op" rule every other Trellis writer follows).
 */
export function writeSecretsPolicyExtraction(path: string, extraction: { varName: string; envFilePath: string }, backup?: BackupSession): SecretsPolicyWriteResult {
  if (!existsSync(path)) {
    return { ok: false, error: `${path} does not exist — run \`trellis init\` first` };
  }
  let doc;
  try {
    doc = parseDocument(readFileSync(path, "utf-8"));
  } catch (err) {
    return { ok: false, error: `could not parse ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (doc.get("env_file") === undefined) {
    doc.set("env_file", extraction.envFilePath);
  }
  // `.get()` returns the raw Seq node for a collection, not a plain
  // array — `.toJS()` on the whole document is the reliable way to read
  // a fully-unwrapped value back out before deciding whether to append.
  const currentAllowedVars = ((doc.toJS() as { allowed_vars?: string[] }).allowed_vars ?? []) as string[];
  if (!currentAllowedVars.includes(extraction.varName)) {
    doc.set("allowed_vars", [...currentAllowedVars, extraction.varName]);
    forceBlockStyle(doc.get("allowed_vars", true));
  }
  persistText(path, doc.toString(), backup);
  return { ok: true };
}

/**
 * Ensures one exact line is present in a `.gitignore` file, creating the
 * file if it doesn't exist yet — idempotent (a no-op if the line is
 * already there), never disturbing any other line
 * (trellis-migrate-extract-static-env-secrets design.md D5). Called
 * lazily, immediately before the first real write to the local secrets
 * file migrate's static-env extraction produces — never from `trellis
 * init`'s own bootstrap, so a machine that never extracts a secret never
 * gains this file at all.
 */
export function ensureGitignoreEntry(gitignorePath: string, line: string, backup?: BackupSession): void {
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
  const lines = existing.split("\n").map((l) => l.trim());
  if (lines.includes(line)) return;
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  persistText(gitignorePath, `${existing}${separator}${line}\n`, backup);
}

const SHELL_ENV_SOURCE_MARKER = "# >>> trellis mcp secrets >>>";
const SHELL_ENV_SOURCE_END_MARKER = "# <<< trellis mcp secrets <<<";

/**
 * Ensures a shell rc file sources the local secrets env file on every new
 * shell — one generic pointer block, appended once, idempotent (detected
 * by its own marker comment, never duplicated). Deliberately never writes
 * a literal secret value into the rc file: the block only names the path
 * to the real `NAME=value` file migrate's extraction already writes and
 * protects — adding a new variable later means editing that one file, the
 * rc file never needs a second edit (trellis-migrate-extract-static-env-secrets
 * design.md D10). `set -a`/`set +a` auto-exports the plain dotenv-format
 * lines `parseDotenv` already expects, so that format never needs an
 * `export` prefix of its own.
 */
export function ensureShellEnvSource(rcPath: string, envFilePath: string, backup?: BackupSession): void {
  const existing = existsSync(rcPath) ? readFileSync(rcPath, "utf-8") : "";
  if (existing.includes(SHELL_ENV_SOURCE_MARKER)) return;
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const block = `${SHELL_ENV_SOURCE_MARKER}\nif [ -f "${envFilePath}" ]; then\n  set -a\n  source "${envFilePath}"\n  set +a\nfi\n${SHELL_ENV_SOURCE_END_MARKER}\n`;
  mkdirSync(dirname(rcPath), { recursive: true });
  persistText(rcPath, `${existing}${separator}${block}`, backup);
}

/** `undefined` if the name has no entry in scope.yaml's map — "shared with
 * all four agents," the default. A recognized but empty list is left as
 * authored (an explicitly agent-less scope), not coerced to "all". */
/** Missing file and `agents: []` both resolve to `[]` — zero managed
 * agents (D1), never "everyone." An unrecognized id is dropped with a
 * diagnostic, same posture as an unrecognized scope.yaml agent id. */
function loadManagedYaml(path: string, diagnostics: string[]): AgentId[] {
  if (!existsSync(path)) {
    return [];
  }
  const parsed = (parseYaml(readFileSync(path, "utf-8")) ?? {}) as ManagedYaml;
  const raw = parsed.agents ?? [];
  const valid: AgentId[] = [];
  for (const id of raw) {
    if ((ALL_AGENTS as readonly string[]).includes(id)) {
      valid.push(id as AgentId);
    } else {
      diagnostics.push(`managed.yaml: "${id}" is not a recognized agent id — ignored`);
    }
  }
  return valid;
}

function scopeFor(map: Record<string, AgentId[]> | undefined, name: string): Scope {
  return map?.[name];
}

function validAgentIds(scope: AgentId[] | undefined): scope is AgentId[] {
  if (!scope) return true;
  return scope.every((id) => (ALL_AGENTS as readonly string[]).includes(id));
}

/**
 * `homeDir` defaults to the real `~` and is only ever overridden for tests
 * and `scripts/sandbox.sh` — the same seam P0's probes use
 * (src/probes/*.ts) and for the same reason: never touch a developer's
 * real dotfiles from a test. It is not a workspace/project root — see
 * specs/canonical-source-loading's global-only requirement, which this
 * parameter does not weaken.
 */
export function loadCanonicalSource(homeDir: string = homedir()): CanonicalSource {
  const root = trellisRoot(homeDir);
  if (!existsSync(root)) {
    throw new Error(
      `No canonical source at ${root}. Create it before running trellis sync — see docs/architecture.md's canonical schema.`,
    );
  }

  const diagnostics: string[] = [];
  const managedAgents = loadManagedYaml(join(root, "managed.yaml"), diagnostics);
  const scopeYaml = loadScopeYaml(join(root, "scope.yaml"));

  const skillDirs = listSkillDirs(join(root, "skills"));
  const knownSkillNames = new Set(skillDirs.map((s) => s.name));
  const skills: SkillRef[] = skillDirs.map(({ name, dir }) => ({ name, dir, scope: scopeFor(scopeYaml.skills, name) }));

  const agentFiles = listMarkdownFiles(join(root, "agents"));
  const knownAgentProfileNames = new Set(agentFiles.map((a) => a.name));
  const agents: AgentProfile[] = agentFiles.map(({ name, file }) => ({
    name,
    file,
    scope: scopeFor(scopeYaml.agents, name),
  }));

  const memoryFiles = listMarkdownFiles(join(root, "memories"));
  const knownMemoryNames = new Set(memoryFiles.map((m) => m.name));
  const memories: MemoryEntry[] = memoryFiles.map(({ name, file }) => ({
    name,
    file,
    scope: scopeFor(scopeYaml.memories, name),
  }));

  for (const [section, known] of [
    ["skills", knownSkillNames],
    ["agents", knownAgentProfileNames],
    ["memories", knownMemoryNames],
  ] as const) {
    const map = scopeYaml[section];
    for (const name of Object.keys(map ?? {})) {
      if (!known.has(name)) {
        diagnostics.push(`scope.yaml: "${section}.${name}" does not match any known ${section.slice(0, -1)} — ignored`);
      } else if (!validAgentIds(map?.[name])) {
        diagnostics.push(`scope.yaml: "${section}.${name}" lists an unrecognized agent id — ignored`);
      }
    }
  }

  return {
    instructionsFile: join(root, "agents.md"),
    managedAgents,
    skills,
    agents,
    memories,
    mcp: loadServersYaml(join(root, "mcp", "servers.yaml")),
    // P2's pre-write guard (src/adapters/mcpPlan.ts) uses its own narrow,
    // hardcoded floor instead of this field — see design.md D1 in
    // trellis-secrets-audit-p3.
    secretsPolicy: loadSecretsPolicyYaml(join(root, "secrets.policy.yaml"), homeDir),
    diagnostics,
  };
}
