/**
 * `trellis migrate --workspace`'s scanner + planner (trellis-workspace-
 * scope tasks 4.1–4.5): inventories every managed agent's project-level
 * MCP config plus the root `AGENTS.md`, classifies each finding, and
 * produces a pure plan — no writes anywhere, so `--dry-run` prints the
 * byte-identical plan a real run would execute.
 *
 * Classification (one `action` per item):
 * - `already-managed`     — the in-repo manifest (`.agents/.trellis-
 *                           rendered.json`) records Trellis having rendered
 *                           this entry, or `.agents/` already holds it
 * - `skip-local`          — a `*.local.*` sibling of a scanned config path;
 *                           listed, never read (task 4.5)
 * - `skip-unsupported`    — malformed entry (e.g. stdio without command)
 * - `extract-secret`      — a reject-pattern literal in `staticEnv`: value
 *                           goes to the global secret store, the committed
 *                           `.agents/config.json` only ever gets `${VAR}`
 * - `identical-to-global` — deep-equal to the global canonical entry;
 *                           default drop, `--dedup override` imports it as
 *                           an intentional shadow (task 4.4)
 * - `conflict`            — same name with differing defs across agents
 *                           (task 4.3, resolved only by `--choose
 *                           name=agentId`), or a reject-pattern literal in
 *                           a field other than `staticEnv` (unlike the
 *                           global migrate, `.agents/config.json` is
 *                           COMMITTED — a plaintext literal must never be
 *                           written into it)
 * - `create`              — will import into `.agents/`
 *
 * Secret handling invariant (task 4.2): no literal secret value ever rides
 * on a plan item — extraction re-reads the source file at apply time,
 * exactly like the global migrate's design.md D9.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentId, McpServerDef, SecretsPolicy } from "../core/types.js";
import { ALL_AGENTS } from "../core/types.js";
import { loadCanonicalSource } from "../core/canonical.js";
import { findLiteralSecret } from "../adapters/mcpPlan.js";
import { fromServerDefYaml } from "../core/mcpServerDef.js";
import { deepEqual } from "./deepEqual.js";
import { fromRichJsonServerDef, readRichJsonMcpDefs } from "./mcpMigrateRead.js";
import type { McpMigrateReadResult } from "./mcpMigrateRead.js";
import { findSection, readServerEnvTable } from "./tomlSection.js";
import { loadWorkspaceRendered, workspaceMcpConfigPath } from "./workspaceMcp.js";
import { readWorkspaceConfigJson, workspaceConfigPath, WORKSPACE_AGENTS_MD_TEMPLATE } from "./workspaceConfig.js";
import { INSTRUCTIONS_MARKER } from "./workspaceFiles.js";

export type WorkspaceMigrateAction =
  | "create"
  | "already-managed"
  | "skip-local"
  | "skip-unsupported"
  | "extract-secret"
  | "identical-to-global"
  | "conflict";

export interface WorkspaceMigrateItem {
  kind: "mcp" | "instructions";
  name: string;
  action: WorkspaceMigrateAction;
  detail: string;
  /** Only set (and only meaningful) on `conflict`: the concrete next
   * action, matching the global migrate's convention. */
  remediation?: string;
  /** Agents whose project config this name was found in. */
  sources: AgentId[];
  /** Set from `--choose name=agentId` — which agent's def won a cross-
   * agent conflict. */
  chosenSource?: AgentId;
  /** Side-by-side defs for a cross-agent conflict, keyed by agent. */
  defs?: Partial<Record<AgentId, McpServerDef>>;
  /** The def to import. On `extract-secret` this is already the SAFE
   * form — the flagged staticEnv value replaced by a name-only `env`
   * reference; the literal never appears on this object. */
  mcpDef?: McpServerDef;
  /** Instructions body to import (root AGENTS.md content). */
  sourceContent?: string;
  /** `extract-secret` only — see the global migrate's D9/D11: the
   * synthesized variable name, the resolved secret-store path, the
   * original staticEnv dict key, and which agent's file to re-read the
   * real value from at apply time. Never the value itself. */
  extractVarName?: string;
  extractTargetPath?: string;
  extractSourceKey?: string;
  extractSourceAgent?: AgentId;
  /** Task 4.2: the source file holding the literal is git-tracked, so the
   * value must be considered compromised — rotate it. */
  rotationAdvisory?: string;
  /** Task 4.4: how an `identical-to-global` item was (or would be)
   * handled — `drop` (default) or `override` (`--dedup override`). */
  dedupChoice?: "drop" | "override";
}

export interface WorkspaceMigratePlan {
  workspaceRoot: string;
  items: WorkspaceMigrateItem[];
}

export interface WorkspaceMigrateScanEntry {
  agent: AgentId;
  name: string;
  def: McpServerDef;
  sourcePath: string;
}

export interface WorkspaceMigrateScan {
  entries: WorkspaceMigrateScanEntry[];
  unsupported: { agent: AgentId; name: string; reason: string; sourcePath: string }[];
  /** `*.local.*` siblings found next to scanned config paths — paths
   * only, contents never read. */
  localFiles: string[];
}

const VAR_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Inverse of `renderServerSection` for a project-level `.codex/config.toml`
 * (task 4.1): no TOML parser dependency exists in this repo (design D2,
 * trellis-mcp-sync-p2), and the global codex reader shells out to `codex
 * mcp list --json` — useless for an arbitrary project file. Hand-rolled
 * against the exact bounded shape `renderServerSection` emits, tolerant of
 * anything else (unknown keys skipped, malformed lines skipped).
 */
const CODEX_SERVER_HEADER_RE = /^\[mcp_servers\.((?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+))\]\s*$/gm;
const CODEX_KV_RE = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/;

function readCodexTomlMcpDefs(configPath: string): McpMigrateReadResult {
  const result: McpMigrateReadResult = { entries: [], unsupported: [] };
  if (!existsSync(configPath)) return result;
  const content = readFileSync(configPath, "utf-8");

  for (const match of content.matchAll(CODEX_SERVER_HEADER_RE)) {
    const segment = match[1];
    const name = segment.startsWith('"') ? (JSON.parse(segment) as string) : segment;
    const range = findSection(content, `mcp_servers.${segment}`);
    if (!range) continue;

    const fields: Record<string, unknown> = {};
    for (const line of content.split("\n").slice(range.start + 1, range.end + 1)) {
      const kv = CODEX_KV_RE.exec(line.trim());
      if (!kv) continue;
      try {
        fields[kv[1]] = JSON.parse(kv[2]);
      } catch {
        // not a JSON-shaped literal (a date, a bare string…) — not a shape
        // renderServerSection ever emits; skip the key, keep the rest
      }
    }

    let def: McpServerDef | undefined;
    if (typeof fields.url === "string") {
      def = { transport: "http", url: fields.url };
      if (typeof fields.bearer_token_env_var === "string") {
        def.headers = { Authorization: `Bearer \${${fields.bearer_token_env_var}}` };
      }
    } else if (typeof fields.command === "string") {
      def = { transport: "stdio", command: fields.command };
      if (Array.isArray(fields.args) && fields.args.every((a) => typeof a === "string") && fields.args.length > 0) {
        def.args = fields.args as string[];
      }
      if (Array.isArray(fields.env_vars) && fields.env_vars.every((a) => typeof a === "string") && fields.env_vars.length > 0) {
        def.env = fields.env_vars as string[];
      }
    } else {
      result.unsupported.push({ name, reason: "entry has neither url nor command — malformed, skipped" });
      continue;
    }

    // The adjacent `[mcp_servers.<name>.env]` table inverts to envAliases
    // (`${VAR}`-shaped values) + staticEnv (everything else) — the exact
    // split renderServerSection performs on the way out.
    const envTable = readServerEnvTable(content, name);
    for (const [key, value] of Object.entries(envTable ?? {})) {
      const ref = VAR_REF_RE.exec(value);
      if (ref) {
        def.envAliases = { ...(def.envAliases ?? {}), [key]: ref[1] };
      } else {
        def.staticEnv = { ...(def.staticEnv ?? {}), [key]: value };
      }
    }
    result.entries.push({ name, def });
  }
  return result;
}

/** zcode's project config nests the rich-JSON shape under `mcp.servers`. */
function readZcodeWorkspaceMcpDefs(configPath: string): McpMigrateReadResult {
  const result: McpMigrateReadResult = { entries: [], unsupported: [] };
  if (!existsSync(configPath)) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return result; // unparsable file — nothing to scan, the sync guard reports it
  }
  const servers = (parsed as { mcp?: { servers?: Record<string, unknown> } })?.mcp?.servers ?? {};
  for (const [name, raw] of Object.entries(servers)) {
    const def = fromRichJsonServerDef(raw as Parameters<typeof fromRichJsonServerDef>[0]);
    if (def) {
      result.entries.push({ name, def });
    } else {
      result.unsupported.push({ name, reason: "stdio entry has no command — malformed, skipped" });
    }
  }
  return result;
}

function readAgentProjectMcpDefs(agentId: AgentId, configPath: string): McpMigrateReadResult {
  if (!existsSync(configPath)) return { entries: [], unsupported: [] };
  if (agentId === "codex") return readCodexTomlMcpDefs(configPath);
  if (agentId === "zcode") return readZcodeWorkspaceMcpDefs(configPath);
  return readRichJsonMcpDefs(configPath);
}

/** `.mcp.json` → `.mcp.local.json`; `config.toml` → `config.local.toml`. */
function localSiblingPath(configPath: string): string {
  return configPath.replace(/\.(json|toml)$/, ".local.$1");
}

/**
 * Apply-time re-read of one agent's project MCP defs (task 4.2, mirroring
 * the global migrate's D9): an extraction's real value is recovered from
 * the source file HERE, at apply time — it never rides on the plan object
 * a `--json`/`--dry-run` caller might log or serialize.
 */
export function readWorkspaceAgentMcpDefsForApply(workspaceRoot: string, agentId: AgentId): McpMigrateReadResult {
  return readAgentProjectMcpDefs(agentId, workspaceMcpConfigPath(agentId, workspaceRoot));
}

/**
 * Inventories all six agents' project-level MCP config paths (the same
 * paths workspace delivery writes, so migration and delivery can never
 * disagree about where an agent reads) plus their `*.local.*` siblings.
 * Pure: reads files, writes nothing.
 */
export function scanWorkspaceMcp(workspaceRoot: string): WorkspaceMigrateScan {
  const scan: WorkspaceMigrateScan = { entries: [], unsupported: [], localFiles: [] };
  for (const agentId of ALL_AGENTS) {
    const configPath = workspaceMcpConfigPath(agentId, workspaceRoot);
    const localPath = localSiblingPath(configPath);
    if (existsSync(localPath)) scan.localFiles.push(localPath);
    const { entries, unsupported } = readAgentProjectMcpDefs(agentId, configPath);
    for (const { name, def } of entries) scan.entries.push({ agent: agentId, name, def, sourcePath: configPath });
    for (const { name, reason } of unsupported) scan.unsupported.push({ agent: agentId, name, reason, sourcePath: configPath });
  }
  return scan;
}

/** `TRELLIS_<SERVER>_<KEY>` — the global migrate's D11 scheme, reused
 * verbatim so a server extracted at either scope follows one convention. */
function synthesizeVarName(serverName: string, key: string): string {
  const part = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "X";
  return `TRELLIS_${part(serverName)}_${part(key)}`;
}

/** Moves `sourceKey` out of `staticEnv` into a name-only `env` reference —
 * the same safe-def transform as the global migrate's `extractedMcpDef`. */
function extractedWorkspaceMcpDef(def: McpServerDef, sourceKey: string, varName: string): McpServerDef {
  const remainingStaticEnv = { ...(def.staticEnv ?? {}) };
  delete remainingStaticEnv[sourceKey];
  const result: McpServerDef = { ...def, env: [...(def.env ?? []), varName] };
  if (Object.keys(remainingStaticEnv).length > 0) {
    result.staticEnv = remainingStaticEnv;
  } else {
    delete result.staticEnv;
  }
  return result;
}

/** Task 4.2: is this source file git-tracked? A literal secret in a
 * tracked file has already been published to every clone — the report
 * must advise rotation. Any failure (not a repo, git absent) means "not
 * tracked", never an error. */
function isGitTracked(workspaceRoot: string, path: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", path], { cwd: workspaceRoot, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export interface CollectWorkspaceMigrateOptions {
  workspaceRoot: string;
  homeDir: string;
  secretsPolicy: SecretsPolicy;
  /** `--choose name=agentId` resolutions for cross-agent conflicts. */
  choose?: Record<string, AgentId>;
  /** `--dedup` handling for `identical-to-global` items; default `drop`. */
  dedup?: "drop" | "override";
}

export function collectWorkspaceMigratePlan(opts: CollectWorkspaceMigrateOptions): WorkspaceMigratePlan {
  const { workspaceRoot, homeDir, secretsPolicy } = opts;
  const choose = opts.choose ?? {};
  const dedup = opts.dedup ?? "drop";
  const items: WorkspaceMigrateItem[] = [];

  const scan = scanWorkspaceMcp(workspaceRoot);
  const manifest = loadWorkspaceRendered(workspaceRoot);
  const workspaceConfig = readWorkspaceConfigJson(workspaceRoot);
  const existingWorkspaceServers = workspaceConfig.mcp?.servers ?? {};
  let globalServers: Record<string, McpServerDef> = {};
  try {
    globalServers = loadCanonicalSource({ homeDir, workspaceDir: null }).mcp.servers;
  } catch {
    // No usable global canonical — dedup simply has nothing to compare
    // against; migration into `.agents/` still works.
  }

  for (const localPath of scan.localFiles) {
    items.push({
      kind: "mcp",
      name: basename(localPath),
      action: "skip-local",
      detail: "personal local file — listed, never read into canonical",
      sources: [],
    });
  }
  for (const entry of scan.unsupported) {
    items.push({
      kind: "mcp",
      name: entry.name,
      action: "skip-unsupported",
      detail: `${entry.agent}: ${entry.reason}`,
      sources: [entry.agent],
    });
  }

  // Group scanned entries by server name; classification then happens
  // once per name, not once per (agent, name) pair.
  const byName = new Map<string, WorkspaceMigrateScanEntry[]>();
  for (const entry of scan.entries) {
    byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
  }

  for (const [name, entries] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sources = entries.map((e) => e.agent);

    // Task 4.1: entries Trellis itself rendered (in-repo manifest) or
    // already imported (`.agents/config.json`) need no migration.
    const unrecorded = entries.filter((e) => manifest.mcp?.[e.agent]?.[e.name] === undefined);
    if (unrecorded.length === 0) {
      items.push({ kind: "mcp", name, action: "already-managed", detail: "Trellis-rendered already (in-repo manifest)", sources });
      continue;
    }

    // Task 4.3: one name, differing defs across agents → the user must
    // pick a side explicitly; the plan shows them side by side.
    const distinct = unrecorded.filter((e, i) => unrecorded.findIndex((o) => deepEqual(o.def, e.def)) === i);
    let chosen: WorkspaceMigrateScanEntry;
    if (distinct.length > 1) {
      const picked = choose[name];
      const pickedEntry = picked !== undefined ? unrecorded.find((e) => e.agent === picked) : undefined;
      if (!pickedEntry) {
        const defs: Partial<Record<AgentId, McpServerDef>> = {};
        for (const e of distinct) defs[e.agent] = e.def;
        items.push({
          kind: "mcp",
          name,
          action: "conflict",
          detail: `defined differently by ${distinct.map((e) => e.agent).join(" and ")} — no def is imported until one is chosen`,
          remediation: `re-run with \`--choose ${name}=<${distinct.map((e) => e.agent).join("|")}>\` after comparing the side-by-side definitions`,
          sources,
          defs,
        });
        continue;
      }
      chosen = pickedEntry;
    } else {
      chosen = distinct[0];
    }
    const def = chosen.def;
    const chosenSource = distinct.length > 1 ? chosen.agent : undefined;

    // Already in `.agents/config.json` with an identical def → nothing to
    // do. The file stores the snake_case yaml shape — convert before
    // comparing against the scanned `McpServerDef`.
    const existingYaml = existingWorkspaceServers[name];
    if (existingYaml !== undefined && deepEqual(fromServerDefYaml(name, existingYaml, workspaceConfigPath(workspaceRoot)), def)) {
      items.push({ kind: "mcp", name, action: "already-managed", detail: "already in .agents/config.json with an identical definition", sources, ...(chosenSource ? { chosenSource } : {}) });
      continue;
    }

    // Task 4.2: reject-pattern literal interception. `staticEnv` has a
    // natural extraction target (its own dict key → TRELLIS_<SERVER>_<KEY>
    // in the global secret store); a literal anywhere else can never be
    // written into the COMMITTED `.agents/config.json`, so it conflicts.
    const secretMatch = findLiteralSecret(def);
    if (secretMatch && secretMatch.field !== "staticEnv") {
      items.push({
        kind: "mcp",
        name,
        action: "conflict",
        detail: `${secretMatch.field} holds a value matching a secrets reject pattern (${secretMatch.label}) — .agents/config.json is committed, so the literal is never written`,
        remediation: `rotate the value, replace it with a \${VAR} reference in the source file, then re-run migrate`,
        sources,
        ...(chosenSource ? { chosenSource } : {}),
      });
      continue;
    }

    const tracked = isGitTracked(workspaceRoot, chosen.sourcePath);
    const rotationAdvisory = secretMatch && tracked
      ? `${chosen.sourcePath} is git-tracked — the ${secretMatch.label} value in it was already committed; rotate it`
      : undefined;

    if (secretMatch) {
      const key = secretMatch.key!;
      const varName = synthesizeVarName(name, key);
      items.push({
        kind: "mcp",
        name,
        action: "extract-secret",
        detail: `will extract "${key}" to the global secret store as "${varName}" and import the server with a \${${varName}} reference — the literal never lands under .agents/`,
        sources,
        ...(chosenSource ? { chosenSource } : {}),
        mcpDef: extractedWorkspaceMcpDef(def, key, varName),
        extractVarName: varName,
        extractTargetPath: secretsPolicy.envFile ?? join(homeDir, ".trellis", "mcp", "servers.local.env"),
        extractSourceKey: key,
        extractSourceAgent: chosen.agent,
        ...(rotationAdvisory ? { rotationAdvisory } : {}),
      });
      continue;
    }

    // Task 4.4: deep-equal to the global layer — importing would create a
    // redundant shadow. Default drop; `--dedup override` records the
    // intentional-shadow choice and imports anyway.
    const global = globalServers[name];
    if (global !== undefined && deepEqual(global, def)) {
      if (dedup === "override") {
        items.push({
          kind: "mcp",
          name,
          action: "create",
          detail: "identical to the global entry — imported anyway as an intentional shadow (--dedup override)",
          sources,
          ...(chosenSource ? { chosenSource } : {}),
          mcpDef: def,
          dedupChoice: "override",
        });
      } else {
        items.push({
          kind: "mcp",
          name,
          action: "identical-to-global",
          detail: "identical to the global entry — dropped (the global layer already provides it); re-run with --dedup override to import it as an intentional shadow",
          sources,
          dedupChoice: "drop",
        });
      }
      continue;
    }

    items.push({
      kind: "mcp",
      name,
      action: "create",
      detail: `will import into .agents/config.json (from ${chosen.agent}${unrecorded.length > 1 ? "; other agents agree" : ""})`,
      sources,
      ...(chosenSource ? { chosenSource } : {}),
      mcpDef: def,
    });
  }

  // Root AGENTS.md → .agents/AGENTS.md. A marker-headed file is Trellis's
  // own rendering — already managed. An unmarked one is imported, unless
  // `.agents/AGENTS.md` already holds real (non-template) content.
  const rootAgentsMd = join(workspaceRoot, "AGENTS.md");
  if (existsSync(rootAgentsMd)) {
    const content = readFileSync(rootAgentsMd, "utf-8");
    if (content.startsWith(INSTRUCTIONS_MARKER)) {
      items.push({ kind: "instructions", name: "AGENTS.md", action: "already-managed", detail: "root AGENTS.md is already Trellis-rendered", sources: [] });
    } else {
      const targetPath = join(workspaceRoot, ".agents", "AGENTS.md");
      const existingInstructions = existsSync(targetPath) ? readFileSync(targetPath, "utf-8") : undefined;
      if (existingInstructions === content) {
        items.push({ kind: "instructions", name: "AGENTS.md", action: "already-managed", detail: ".agents/AGENTS.md already holds the same content", sources: [] });
      } else if (existingInstructions !== undefined && existingInstructions !== WORKSPACE_AGENTS_MD_TEMPLATE) {
        items.push({
          kind: "instructions",
          name: "AGENTS.md",
          action: "conflict",
          detail: "both root AGENTS.md and .agents/AGENTS.md hold real content — not merged automatically",
          remediation: "merge the two by hand into .agents/AGENTS.md, remove the root file, then re-run migrate",
          sources: [],
        });
      } else {
        items.push({
          kind: "instructions",
          name: "AGENTS.md",
          action: "create",
          detail: "will import root AGENTS.md into .agents/AGENTS.md and re-render the root file marker-headed",
          sources: [],
          sourceContent: content,
        });
      }
    }
  }

  return { workspaceRoot, items };
}
