/**
 * `trellis skill list|add|remove` — command-line CRUD for canonical
 * skills (trellis-canonical-cli-crud), an alternative to hand-editing
 * `~/.trellis/skills/<name>/SKILL.md` directly. `add`'s conflict
 * decision and `remove`'s "sync will un-sync it" behavior both reuse
 * existing, already-shipped logic rather than reimplementing it — see
 * `decideDirImport` (src/lib/dirEquals.ts) and `src/adapters/
 * symlinkPlan.ts`'s pre-existing stale-symlink removal.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decideDirImport } from "../lib/dirEquals.js";
import { findSkillFile } from "../lib/skillFile.js";
import { loadCanonicalSource } from "../core/canonical.js";
import { resolveScope } from "../core/types.js";
import type { AgentId } from "../core/types.js";

export interface SkillListEntry {
  name: string;
  scope: readonly AgentId[];
}

export function collectSkillList(homeDir: string = homedir()): SkillListEntry[] {
  const canonical = loadCanonicalSource(homeDir);
  return canonical.skills.map((skill) => ({
    name: skill.name,
    scope: resolveScope(skill.scope, canonical.managedAgents),
  }));
}

export function runSkillList(opts: { homeDir?: string; json?: boolean } = {}): { exitCode: number } {
  const entries = collectSkillList(opts.homeDir ?? homedir());
  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2));
  } else if (entries.length === 0) {
    console.log("No skills in canonical source yet.");
  } else {
    for (const { name, scope } of entries) {
      console.log(`${name} — ${scope.length > 0 ? scope.join(", ") : "(no managed agent reaches it)"}`);
    }
  }
  return { exitCode: 0 };
}

export type SkillAddAction = "create" | "already-present" | "conflict" | "invalid-source";

export interface SkillAddPlan {
  name: string;
  action: SkillAddAction;
  detail: string;
  sourceDir?: string;
}

export function collectSkillAddPlan(name: string, fromPath: string, homeDir: string = homedir()): SkillAddPlan {
  const skillFile = findSkillFile(fromPath);
  if (!skillFile) {
    return { name, action: "invalid-source", detail: `${fromPath} has no SKILL.md` };
  }
  if (!skillFile.caseCorrect) {
    return { name, action: "invalid-source", detail: `${fromPath} has skill.md, not case-correct SKILL.md — fix the case first` };
  }

  const canonicalDir = join(homeDir, ".trellis", "skills", name);
  switch (decideDirImport(fromPath, canonicalDir)) {
    case "create":
      return { name, action: "create", detail: `will copy from ${fromPath}`, sourceDir: fromPath };
    case "already-present":
      return { name, action: "already-present", detail: "canonical content is already byte-identical" };
    case "conflict":
      return { name, action: "conflict", detail: `canonical skills/${name}/ already exists with different content — resolve by hand` };
  }
}

export function applySkillAddPlan(plan: SkillAddPlan, homeDir: string = homedir()): void {
  if (plan.action !== "create" || !plan.sourceDir) return;
  const dest = join(homeDir, ".trellis", "skills", plan.name);
  mkdirSync(dest, { recursive: true });
  cpSync(plan.sourceDir, dest, { recursive: true });
}

export function runSkillAdd(name: string, fromPath: string, opts: { homeDir?: string; json?: boolean; dryRun?: boolean } = {}): { exitCode: number } {
  const homeDir = opts.homeDir ?? homedir();
  const plan = collectSkillAddPlan(name, fromPath, homeDir);
  if (!opts.dryRun && plan.action === "create") {
    applySkillAddPlan(plan, homeDir);
  }
  if (opts.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(`${opts.dryRun ? "[dry run] " : ""}skill add ${name}`);
    console.log(`  [${plan.action}] ${plan.detail}`);
  }
  return { exitCode: plan.action === "conflict" || plan.action === "invalid-source" ? 1 : 0 };
}

export type SkillRemoveAction = "removed" | "not-found";

export interface SkillRemovePlan {
  name: string;
  action: SkillRemoveAction;
}

export function collectSkillRemovePlan(name: string, homeDir: string = homedir()): SkillRemovePlan {
  const dir = join(homeDir, ".trellis", "skills", name);
  return { name, action: existsSync(dir) ? "removed" : "not-found" };
}

export function applySkillRemovePlan(plan: SkillRemovePlan, homeDir: string = homedir()): void {
  if (plan.action !== "removed") return;
  rmSync(join(homeDir, ".trellis", "skills", plan.name), { recursive: true, force: true });
}

export function runSkillRemove(name: string, opts: { homeDir?: string; json?: boolean; dryRun?: boolean } = {}): { exitCode: number } {
  const homeDir = opts.homeDir ?? homedir();
  const plan = collectSkillRemovePlan(name, homeDir);
  if (!opts.dryRun) {
    applySkillRemovePlan(plan, homeDir);
  }
  if (opts.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else if (plan.action === "not-found") {
    console.error(`"${name}" is not a canonical skill — nothing to remove.`);
  } else {
    console.log(`${opts.dryRun ? "[dry run] " : ""}removed skill "${name}" from canonical source.`);
  }
  return { exitCode: plan.action === "not-found" ? 1 : 0 };
}
