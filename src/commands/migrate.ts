/**
 * `trellis migrate --from <agent>` — imports an existing agent's real
 * skills and instructions into canonical source (trellis-cli-migrate).
 * Pure `collectMigratePlan` / effectful `applyMigratePlan`, same
 * plan-then-apply split every adapter already uses.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as claudeCodeProbe from "../probes/claude-code.js";
import * as codexProbe from "../probes/codex.js";
import * as kiroProbe from "../probes/kiro.js";
import * as piProbe from "../probes/pi.js";
import { AGENTS_MD_TEMPLATE } from "./init.js";
import { decideDirImport } from "../lib/dirEquals.js";
import { deepEqual } from "../lib/deepEqual.js";
import { readClaudeCodeMcpDefs, readCodexMcpDefs, readKiroMcpDefs } from "../lib/mcpMigrateRead.js";
import { loadCanonicalSource, upsertServerYaml } from "../core/canonical.js";
import { ALL_AGENTS } from "../core/types.js";
import type { AgentId, AgentSnapshot, McpServerDef } from "../core/types.js";

const PROBES: Record<AgentId, (homeDir: string) => Promise<AgentSnapshot>> = {
  "claude-code": (homeDir) => claudeCodeProbe.probe(homeDir),
  codex: (homeDir) => codexProbe.probe(homeDir),
  kiro: (homeDir) => kiroProbe.probe(homeDir),
  pi: (homeDir) => piProbe.probe(homeDir),
};

/** pi has no static MCP config to read at all (roadmap.md P14/
 * trellis-migrate-mcp-servers) — deliberately absent, not an oversight;
 * `collectMigratePlan` skips the `mcp` category entirely for pi. */
const MCP_READERS: Partial<Record<AgentId, (homeDir: string) => { entries: { name: string; def: McpServerDef }[]; unsupported: { name: string; reason: string }[] }>> = {
  "claude-code": readClaudeCodeMcpDefs,
  kiro: readKiroMcpDefs,
  codex: readCodexMcpDefs,
};

export type MigrateAction = "create" | "skip-symlink" | "skip-case-broken" | "skip-unsupported" | "already-migrated" | "conflict";

/** Internal kind naming, unchanged since before `--only` existed
 * (trellis-migrate-category-selection design.md D2) — the CLI-facing
 * flag value is the plural `"skills"`, mapped to this singular `"skill"`
 * in `runMigrate`, not renamed here to avoid touching every existing
 * `MigratePlanItem.kind` comparison for no functional reason. */
export type MigrateKind = "skill" | "instructions" | "mcp";

export interface MigratePlanItem {
  kind: MigrateKind;
  name: string;
  action: MigrateAction;
  detail: string;
  /** Only set when action === "create"; consumed by applyMigratePlan. */
  sourceDir?: string;
  sourceContent?: string;
  /** Only set when kind === "mcp" && action === "create". */
  mcpDef?: McpServerDef;
}

export interface MigratePlan {
  agent: AgentId;
  present: boolean;
  items: MigratePlanItem[];
}

function planSkill(name: string, sourceDir: string, isSymlink: boolean, caseCorrect: boolean, canonicalDir: string): MigratePlanItem {
  if (isSymlink) {
    return { kind: "skill", name, action: "skip-symlink", detail: "shared in from elsewhere, not this agent's own content" };
  }
  if (!caseCorrect) {
    return { kind: "skill", name, action: "skip-case-broken", detail: "already undiscoverable on at least one other agent — fix on the source before migrating" };
  }
  switch (decideDirImport(sourceDir, canonicalDir)) {
    case "create":
      return { kind: "skill", name, action: "create", detail: `will copy from ${sourceDir}`, sourceDir };
    case "already-present":
      return { kind: "skill", name, action: "already-migrated", detail: "canonical content is byte-identical" };
    case "conflict":
      return { kind: "skill", name, action: "conflict", detail: `canonical skills/${name}/ already exists with different content — resolve by hand` };
  }
}

function planInstructions(snapshot: AgentSnapshot, canonicalAgentsMd: string): MigratePlanItem | undefined {
  if (!snapshot.instructionsFile) return undefined;
  if (snapshot.instructionsFile.isSymlink) {
    return { kind: "instructions", name: "agents.md", action: "skip-symlink", detail: "source agent's instructions file is itself a symlink, nothing real to read" };
  }
  let sourceContent: string;
  try {
    sourceContent = readFileSync(snapshot.instructionsFile.path, "utf-8");
  } catch (err) {
    return { kind: "instructions", name: "agents.md", action: "conflict", detail: `could not read source instructions: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!existsSync(canonicalAgentsMd)) {
    return { kind: "instructions", name: "agents.md", action: "create", detail: "canonical agents.md does not exist yet", sourceContent };
  }
  const current = readFileSync(canonicalAgentsMd, "utf-8");
  if (current === AGENTS_MD_TEMPLATE) {
    return { kind: "instructions", name: "agents.md", action: "create", detail: "canonical agents.md is still trellis init's placeholder", sourceContent };
  }
  if (current === sourceContent) {
    return { kind: "instructions", name: "agents.md", action: "already-migrated", detail: "canonical content is byte-identical" };
  }
  return { kind: "instructions", name: "agents.md", action: "conflict", detail: "canonical agents.md already has different real content — resolve by hand" };
}

function planMcpServer(name: string, def: McpServerDef, existing: McpServerDef | undefined): MigratePlanItem {
  if (existing === undefined) {
    return { kind: "mcp", name, action: "create", detail: "will add to servers.yaml", mcpDef: def };
  }
  if (deepEqual(existing, def)) {
    return { kind: "mcp", name, action: "already-migrated", detail: "canonical definition is already identical" };
  }
  return { kind: "mcp", name, action: "conflict", detail: `canonical mcp/servers.yaml already has a different definition for "${name}" — resolve by hand` };
}

/**
 * `only` restricts which kind(s) are even considered — not a post-hoc
 * filter on a fully-computed plan (trellis-migrate-category-selection
 * design.md D3): the excluded kind's canonical path is never read for
 * comparison and never appears in the plan, not even as a suppressed
 * conflict. Omitting `only` (or passing both kinds) is exactly today's
 * behavior.
 */
export async function collectMigratePlan(agent: AgentId, homeDir: string = homedir(), only?: readonly MigrateKind[]): Promise<MigratePlan> {
  const snapshot = await PROBES[agent](homeDir);
  if (!snapshot.present) {
    return { agent, present: false, items: [] };
  }

  const canonicalRoot = join(homeDir, ".trellis");
  const items: MigratePlanItem[] = [];
  const wants = (kind: MigrateKind) => !only || only.includes(kind);

  if (wants("skill")) {
    for (const root of snapshot.skillRoots) {
      for (const skill of root.skills) {
        items.push(planSkill(skill.name, skill.dir, skill.isSymlink, skill.caseCorrect, join(canonicalRoot, "skills", skill.name)));
      }
    }
  }

  if (wants("instructions")) {
    const instructionsItem = planInstructions(snapshot, join(canonicalRoot, "agents.md"));
    if (instructionsItem) items.push(instructionsItem);
  }

  if (wants("mcp")) {
    const reader = MCP_READERS[agent];
    if (reader) {
      const canonicalServers = loadCanonicalSource(homeDir).mcp.servers;
      const { entries, unsupported } = reader(homeDir);
      for (const { name, def } of entries) {
        items.push(planMcpServer(name, def, canonicalServers[name]));
      }
      for (const { name, reason } of unsupported) {
        items.push({ kind: "mcp", name, action: "skip-unsupported", detail: reason });
      }
    }
  }

  return { agent, present: true, items };
}

export function applyMigratePlan(plan: MigratePlan, homeDir: string = homedir()): void {
  const canonicalRoot = join(homeDir, ".trellis");
  for (const item of plan.items) {
    if (item.action !== "create") continue;
    if (item.kind === "skill" && item.sourceDir) {
      const dest = join(canonicalRoot, "skills", item.name);
      mkdirSync(dest, { recursive: true });
      cpSync(item.sourceDir, dest, { recursive: true });
    } else if (item.kind === "instructions" && item.sourceContent !== undefined) {
      mkdirSync(canonicalRoot, { recursive: true });
      writeFileSync(join(canonicalRoot, "agents.md"), item.sourceContent);
    } else if (item.kind === "mcp" && item.mcpDef) {
      upsertServerYaml(join(canonicalRoot, "mcp", "servers.yaml"), item.name, item.mcpDef);
    }
  }
}

/** CLI-facing spelling: `"skills"` (plural — a run usually touches more
 * than one), `"instructions"` (already singular-shaped), or `"mcp"`
 * (already the CLI's own convention, matching `trellis mcp`'s own
 * command name). Mapped to `MigrateKind` in `runMigrate`, the one place
 * this translation lives. */
export type MigrateOnlyValue = "skills" | "instructions" | "mcp";

export interface RunMigrateOptions {
  from?: string;
  /** Restricts the run to one category (`"skills"`, `"instructions"`, or
   * `"mcp"`, raw and unvalidated same as `from` — `runMigrate` checks
   * it). `undefined` means all three, exactly as before `"mcp"` existed. */
  only?: string;
  dryRun?: boolean;
  json?: boolean;
  /** Defaults to the real `~`; overridable for tests only. */
  homeDir?: string;
}

const ONLY_VALUES: readonly MigrateOnlyValue[] = ["skills", "instructions", "mcp"];

function isMigrateOnlyValue(value: string): value is MigrateOnlyValue {
  return (ONLY_VALUES as readonly string[]).includes(value);
}

function toMigrateKinds(only: MigrateOnlyValue): readonly MigrateKind[] {
  if (only === "skills") return ["skill"];
  if (only === "instructions") return ["instructions"];
  return ["mcp"];
}

export async function runMigrate(opts: RunMigrateOptions = {}): Promise<{ exitCode: number }> {
  const homeDir = opts.homeDir ?? homedir();

  if (!opts.from || !(ALL_AGENTS as readonly string[]).includes(opts.from)) {
    console.error(`--from must be one of: ${ALL_AGENTS.join(", ")} (got ${opts.from ?? "(none)"})`);
    return { exitCode: 1 };
  }
  const agent = opts.from as AgentId;

  if (opts.only !== undefined && !isMigrateOnlyValue(opts.only)) {
    console.error(`--only must be one of: ${ONLY_VALUES.join(", ")} (got ${opts.only})`);
    return { exitCode: 1 };
  }
  const only = opts.only && isMigrateOnlyValue(opts.only) ? toMigrateKinds(opts.only) : undefined;

  const plan = await collectMigratePlan(agent, homeDir, only);
  if (!plan.present) {
    console.error(`${agent} is not present on this machine — nothing to migrate.`);
    return { exitCode: 1 };
  }

  if (!opts.dryRun) {
    applyMigratePlan(plan, homeDir);
  }

  if (opts.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    printPlan(plan, opts.dryRun ?? false);
  }

  const hasConflict = plan.items.some((i) => i.action === "conflict");
  return { exitCode: hasConflict ? 1 : 0 };
}

/** Exported so `onboard` prints a migrate plan identically to running
 * `migrate` standalone, instead of a second, easily-drifting copy of
 * this formatting (including the empty-plan "nothing to migrate" case). */
export function printPlan(plan: MigratePlan, dryRun: boolean): void {
  console.log(`${dryRun ? "[dry run] " : ""}migrate --from ${plan.agent}`);
  if (plan.items.length === 0) {
    console.log("  nothing to migrate");
    return;
  }
  for (const item of plan.items) {
    const label = item.kind === "skill" ? `skill "${item.name}"` : item.kind === "mcp" ? `mcp server "${item.name}"` : "instructions";
    console.log(`  [${item.action}] ${label} — ${item.detail}`);
  }
}
