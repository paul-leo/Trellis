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
import { dirContentsEqual } from "../lib/dirEquals.js";
import { ALL_AGENTS } from "../core/types.js";
import type { AgentId, AgentSnapshot } from "../core/types.js";

const PROBES: Record<AgentId, (homeDir: string) => Promise<AgentSnapshot>> = {
  "claude-code": (homeDir) => claudeCodeProbe.probe(homeDir),
  codex: (homeDir) => codexProbe.probe(homeDir),
  kiro: (homeDir) => kiroProbe.probe(homeDir),
  pi: (homeDir) => piProbe.probe(homeDir),
};

export type MigrateAction = "create" | "skip-symlink" | "skip-case-broken" | "already-migrated" | "conflict";

export interface MigratePlanItem {
  kind: "skill" | "instructions";
  name: string;
  action: MigrateAction;
  detail: string;
  /** Only set when action === "create"; consumed by applyMigratePlan. */
  sourceDir?: string;
  sourceContent?: string;
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
  if (!existsSync(canonicalDir)) {
    return { kind: "skill", name, action: "create", detail: `will copy from ${sourceDir}`, sourceDir };
  }
  if (dirContentsEqual(sourceDir, canonicalDir)) {
    return { kind: "skill", name, action: "already-migrated", detail: "canonical content is byte-identical" };
  }
  return { kind: "skill", name, action: "conflict", detail: `canonical skills/${name}/ already exists with different content — resolve by hand` };
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

export async function collectMigratePlan(agent: AgentId, homeDir: string = homedir()): Promise<MigratePlan> {
  const snapshot = await PROBES[agent](homeDir);
  if (!snapshot.present) {
    return { agent, present: false, items: [] };
  }

  const canonicalRoot = join(homeDir, ".trellis");
  const items: MigratePlanItem[] = [];

  for (const root of snapshot.skillRoots) {
    for (const skill of root.skills) {
      items.push(planSkill(skill.name, skill.dir, skill.isSymlink, skill.caseCorrect, join(canonicalRoot, "skills", skill.name)));
    }
  }

  const instructionsItem = planInstructions(snapshot, join(canonicalRoot, "agents.md"));
  if (instructionsItem) items.push(instructionsItem);

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
    }
  }
}

export interface RunMigrateOptions {
  from?: string;
  dryRun?: boolean;
  json?: boolean;
  /** Defaults to the real `~`; overridable for tests only. */
  homeDir?: string;
}

export async function runMigrate(opts: RunMigrateOptions = {}): Promise<{ exitCode: number }> {
  const homeDir = opts.homeDir ?? homedir();

  if (!opts.from || !(ALL_AGENTS as readonly string[]).includes(opts.from)) {
    console.error(`--from must be one of: ${ALL_AGENTS.join(", ")} (got ${opts.from ?? "(none)"})`);
    return { exitCode: 1 };
  }
  const agent = opts.from as AgentId;

  const plan = await collectMigratePlan(agent, homeDir);
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
    console.log(`  [${item.action}] ${item.kind === "skill" ? `skill "${item.name}"` : "instructions"} — ${item.detail}`);
  }
}
