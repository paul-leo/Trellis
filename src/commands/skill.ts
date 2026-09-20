/**
 * `trellis skill list|add|remove` — command-line CRUD for canonical
 * skills (trellis-canonical-cli-crud), an alternative to hand-editing
 * `~/.trellis/skills/<name>/SKILL.md` directly. `add`'s conflict
 * decision and `remove`'s "sync will un-sync it" behavior both reuse
 * existing, already-shipped logic rather than reimplementing it — see
 * `decideDirImport` (src/lib/dirEquals.ts) and `src/adapters/
 * symlinkPlan.ts`'s pre-existing stale-symlink removal.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decideDirImport } from "../lib/dirEquals.js";
import { findSkillFile } from "../lib/skillFile.js";
import { loadCanonicalSource } from "../core/canonical.js";
import { resolveScope } from "../core/types.js";
import type { AgentId } from "../core/types.js";
import { isBuiltinSkillName } from "../lib/builtinSkills.js";
import { openBackupSession, type BackupSession } from "../lib/backup.js";
import { collectSyncReport, printReport as printSyncReport } from "./sync.js";
import type { SyncReport } from "./sync.js";

function builtinSkillTemplate(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "..", "..", "schema", "builtin-skills", "trellis-runtime", "SKILL.md"), "utf8");
}

export type BuiltinSkillUpdateAction = "create" | "update" | "already-current";

export interface BuiltinSkillUpdatePlan {
  name: "trellis-runtime";
  action: BuiltinSkillUpdateAction;
  detail: string;
  path: string;
}

export function collectBuiltinSkillUpdatePlan(homeDir: string = homedir()): BuiltinSkillUpdatePlan {
  const path = join(homeDir, ".trellis", "skills", "trellis-runtime", "SKILL.md");
  if (!existsSync(path)) return { name: "trellis-runtime", action: "create", detail: "will install the package-owned Runtime Skill", path };
  if (readFileSync(path, "utf8") === builtinSkillTemplate()) return { name: "trellis-runtime", action: "already-current", detail: "package-owned Runtime Skill is already current", path };
  return { name: "trellis-runtime", action: "update", detail: "will refresh the package-owned Runtime Skill; existing Agent symlinks will see the update", path };
}

export function applyBuiltinSkillUpdatePlan(plan: BuiltinSkillUpdatePlan, backup?: BackupSession): void {
  if (plan.action === "already-current") return;
  const content = builtinSkillTemplate();
  mkdirSync(dirname(plan.path), { recursive: true });
  if (backup) backup.writeFile(plan.path, content);
  else writeFileSync(plan.path, content);
}

export function runSkillUpdateBuiltin(opts: { homeDir?: string; json?: boolean; dryRun?: boolean } = {}): { exitCode: number } {
  const homeDir = opts.homeDir ?? homedir();
  const plan = collectBuiltinSkillUpdatePlan(homeDir);
  if (!opts.dryRun && plan.action !== "already-current") {
    const backup = openBackupSession(homeDir, "skill-update-builtin");
    applyBuiltinSkillUpdatePlan(plan, backup);
    backup.finalize();
  }
  if (opts.json) console.log(JSON.stringify(plan, null, 2));
  else console.log(`${opts.dryRun ? "[dry run] " : ""}skill update-builtin\n  [${plan.action}] ${plan.detail}`);
  return { exitCode: 0 };
}

export interface SkillListEntry {
  name: string;
  scope: readonly AgentId[];
}

export function collectSkillList(homeDir: string = homedir()): SkillListEntry[] {
  const canonical = loadCanonicalSource(homeDir);
  return canonical.skills.filter((skill) => !isBuiltinSkillName(skill.name)).map((skill) => ({
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
  if (isBuiltinSkillName(name)) {
    return { name, action: "conflict", detail: `"${name}" is a Trellis package-owned Skill and cannot be replaced with skill add` };
  }
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

export async function runSkillAdd(name: string, fromPath: string, opts: { homeDir?: string; json?: boolean; dryRun?: boolean } = {}): Promise<{ exitCode: number }> {
  const homeDir = opts.homeDir ?? homedir();
  const plan = collectSkillAddPlan(name, fromPath, homeDir);
  if (!opts.dryRun && plan.action === "create") {
    applySkillAddPlan(plan, homeDir);
  }
  const failed = plan.action === "conflict" || plan.action === "invalid-source";
  let syncReport: SyncReport | undefined;
  if (!failed && plan.action === "create" && existsSync(join(homeDir, ".trellis"))) {
    syncReport = await collectSyncReport({ target: "skills", homeDir, dryRun: opts.dryRun });
  }
  if (opts.json) {
    console.log(JSON.stringify(syncReport ? { ...plan, sync: syncReport } : plan, null, 2));
  } else {
    console.log(`${opts.dryRun ? "[dry run] " : ""}skill add ${name}`);
    console.log(`  [${plan.action}] ${plan.detail}`);
    if (syncReport) printSyncReport(syncReport, opts.dryRun ?? false);
  }
  const syncConflict = syncReport?.reports.some((r) => r.items.some((i) => i.action === "conflict")) ?? false;
  return { exitCode: failed || syncConflict ? 1 : 0 };
}

export type SkillRemoveAction = "removed" | "not-found";

export interface SkillRemovePlan {
  name: string;
  action: SkillRemoveAction;
}

export function collectSkillRemovePlan(name: string, homeDir: string = homedir()): SkillRemovePlan {
  if (isBuiltinSkillName(name)) return { name, action: "not-found" };
  const dir = join(homeDir, ".trellis", "skills", name);
  return { name, action: existsSync(dir) ? "removed" : "not-found" };
}

export function applySkillRemovePlan(plan: SkillRemovePlan, homeDir: string = homedir()): void {
  if (plan.action !== "removed") return;
  rmSync(join(homeDir, ".trellis", "skills", plan.name), { recursive: true, force: true });
}

export async function runSkillRemove(name: string, opts: { homeDir?: string; json?: boolean; dryRun?: boolean } = {}): Promise<{ exitCode: number }> {
  const homeDir = opts.homeDir ?? homedir();
  const plan = collectSkillRemovePlan(name, homeDir);
  if (!opts.dryRun) {
    applySkillRemovePlan(plan, homeDir);
  }
  const failed = plan.action === "not-found";
  let syncReport: SyncReport | undefined;
  if (!failed && existsSync(join(homeDir, ".trellis"))) {
    syncReport = await collectSyncReport({ target: "skills", homeDir, dryRun: opts.dryRun });
  }
  if (opts.json) {
    console.log(JSON.stringify(syncReport ? { ...plan, sync: syncReport } : plan, null, 2));
  } else if (plan.action === "not-found") {
    console.error(`"${name}" is not a canonical skill — nothing to remove.`);
  } else {
    console.log(`${opts.dryRun ? "[dry run] " : ""}removed skill "${name}" from canonical source.`);
    if (syncReport) printSyncReport(syncReport, opts.dryRun ?? false);
  }
  const syncConflict = syncReport?.reports.some((r) => r.items.some((i) => i.action === "conflict")) ?? false;
  return { exitCode: failed || syncConflict ? 1 : 0 };
}
