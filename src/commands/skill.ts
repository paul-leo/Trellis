/**
 * `trellis skill list|add|remove|scope` — command-line CRUD for canonical
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
import { loadCanonicalSource, writeSkillScopeYaml } from "../core/canonical.js";
import { resolveScope } from "../core/types.js";
import type { AgentId } from "../core/types.js";
import { isBuiltinSkillName } from "../lib/builtinSkills.js";
import { openBackupSession, type BackupSession } from "../lib/backup.js";
import { collectSyncReport, printReport as printSyncReport } from "./sync.js";
import type { SyncReport } from "./sync.js";
import { remoteSkillProvenance } from "./remoteSkill.js";
import { describeScope, resolveScopeSelection, sameScope, type ScopeSelectorRaw } from "../lib/scopeSelection.js";
import type { RemoteSkillLockEntry } from "../lib/remoteSkillLock.js";

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
  remote?: Pick<RemoteSkillLockEntry, "source" | "requestedRef" | "commit" | "subdirectory" | "digest">;
}

export function collectSkillList(homeDir: string = homedir()): SkillListEntry[] {
  const canonical = loadCanonicalSource(homeDir);
  const provenance = remoteSkillProvenance(homeDir);
  return canonical.skills.filter((skill) => !isBuiltinSkillName(skill.name)).map((skill) => ({
    name: skill.name,
    scope: resolveScope(skill.scope, canonical.managedAgents),
    ...(provenance[skill.name] ? { remote: provenance[skill.name] } : {}),
  }));
}

export function runSkillList(opts: { homeDir?: string; json?: boolean } = {}): { exitCode: number } {
  const entries = collectSkillList(opts.homeDir ?? homedir());
  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2));
  } else if (entries.length === 0) {
    console.log("No skills in canonical source yet.");
  } else {
    for (const { name, scope, remote } of entries) {
      const provenance = remote ? ` — remote: ${remote.source}@${remote.commit.slice(0, 12)}` : "";
      console.log(`${name} — ${scope.length > 0 ? scope.join(", ") : "(no managed agent reaches it)"}${provenance}`);
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

export function applySkillAddPlan(plan: SkillAddPlan, homeDir: string = homedir(), backup?: BackupSession): void {
  if (plan.action !== "create" || !plan.sourceDir) return;
  const dest = join(homeDir, ".trellis", "skills", plan.name);
  if (backup) {
    backup.createDirFromSource(dest, plan.sourceDir);
    return;
  }
  mkdirSync(dest, { recursive: true });
  cpSync(plan.sourceDir, dest, { recursive: true });
}

export interface SkillAddOutcome {
  plan: SkillAddPlan;
  sync?: SyncReport;
}

/**
 * See `applyMcpAddWithSync`'s doc comment (mcp.ts) — same split, same
 * reason: a non-CLI caller needs the structured result a JSON-mode CLI
 * run prints, without scraping stdout. Also opens its own backup session
 * around the canonical copy-in, for the same reason `applyMcpAddWithSync`
 * does (trellis-gui tasks.md 3.5): this direct write used to be the one
 * path in this file with no backup/rollback trace at all.
 */
export async function applySkillAddWithSync(plan: SkillAddPlan, opts: { homeDir?: string; dryRun?: boolean; backupSession?: BackupSession } = {}): Promise<SkillAddOutcome> {
  const homeDir = opts.homeDir ?? homedir();
  const ownSession = !opts.dryRun && !opts.backupSession && plan.action === "create" ? openBackupSession(homeDir, "skill-add") : undefined;
  const session = opts.backupSession ?? ownSession;
  if (!opts.dryRun && plan.action === "create") {
    applySkillAddPlan(plan, homeDir, session);
  }
  ownSession?.finalize();
  const failed = plan.action === "conflict" || plan.action === "invalid-source";
  let syncReport: SyncReport | undefined;
  if (!failed && plan.action === "create" && existsSync(join(homeDir, ".trellis"))) {
    syncReport = await collectSyncReport({ target: "skills", homeDir, dryRun: opts.dryRun });
  }
  return { plan, ...(syncReport ? { sync: syncReport } : {}) };
}

export async function runSkillAdd(name: string, fromPath: string, opts: { homeDir?: string; json?: boolean; dryRun?: boolean } = {}): Promise<{ exitCode: number }> {
  const homeDir = opts.homeDir ?? homedir();
  const plan = collectSkillAddPlan(name, fromPath, homeDir);
  const { sync: syncReport } = await applySkillAddWithSync(plan, { homeDir, dryRun: opts.dryRun });
  const failed = plan.action === "conflict" || plan.action === "invalid-source";
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

export function applySkillRemovePlan(plan: SkillRemovePlan, homeDir: string = homedir(), backup?: BackupSession): void {
  if (plan.action !== "removed") return;
  const dir = join(homeDir, ".trellis", "skills", plan.name);
  if (backup) {
    backup.removeDir(dir);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}

export interface SkillRemoveOutcome {
  plan: SkillRemovePlan;
  sync?: SyncReport;
}

/** See `applySkillAddWithSync`'s doc comment — same split, same reason,
 * same own-backup-session fix. */
export async function applySkillRemoveWithSync(plan: SkillRemovePlan, opts: { homeDir?: string; dryRun?: boolean; backupSession?: BackupSession } = {}): Promise<SkillRemoveOutcome> {
  const homeDir = opts.homeDir ?? homedir();
  const ownSession = !opts.dryRun && !opts.backupSession && plan.action === "removed" ? openBackupSession(homeDir, "skill-remove") : undefined;
  const session = opts.backupSession ?? ownSession;
  if (!opts.dryRun) {
    applySkillRemovePlan(plan, homeDir, session);
  }
  ownSession?.finalize();
  const failed = plan.action === "not-found";
  let syncReport: SyncReport | undefined;
  if (!failed && existsSync(join(homeDir, ".trellis"))) {
    syncReport = await collectSyncReport({ target: "skills", homeDir, dryRun: opts.dryRun });
  }
  return { plan, ...(syncReport ? { sync: syncReport } : {}) };
}

export async function runSkillRemove(name: string, opts: { homeDir?: string; json?: boolean; dryRun?: boolean } = {}): Promise<{ exitCode: number }> {
  const homeDir = opts.homeDir ?? homedir();
  const plan = collectSkillRemovePlan(name, homeDir);
  const { sync: syncReport } = await applySkillRemoveWithSync(plan, { homeDir, dryRun: opts.dryRun });
  const failed = plan.action === "not-found";
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

export type SkillScopeAction = "updated" | "already-set" | "not-found" | "invalid-input";

export interface SkillScopePlan {
  name: string;
  action: SkillScopeAction;
  detail: string;
  /** What will be recorded in `scope.yaml`; `undefined` clears the explicit
   * scope so the skill reaches every managed agent. Set when the selection was
   * valid, whatever the action. */
  scope?: AgentId[];
  mode?: "all" | "none" | "explicit";
  /** True when a full selection was dropped instead of recorded
   * (trellis-scope-editing-and-auth-status design.md D3). */
  normalizedFromFull?: boolean;
  /** The agents that will actually receive the skill afterwards. */
  effective?: readonly AgentId[];
}

/**
 * `skill scope <name> --agents a,b | --all | --none`
 * (trellis-scope-editing-and-auth-status tasks.md 1.1). Plan only — the write
 * and the cascade sync live in `applySkillScopeWithSync`.
 */
export function collectSkillScopePlan(name: string | undefined, raw: ScopeSelectorRaw, homeDir: string = homedir()): SkillScopePlan {
  if (!name) return { name: "(none)", action: "invalid-input", detail: "usage: trellis skill scope <name> --agents <ids> | --all | --none" };
  if (isBuiltinSkillName(name)) {
    return { name, action: "invalid-input", detail: `"${name}" is a Trellis package-owned Skill — its scope is not editable` };
  }

  const canonical = loadCanonicalSource(homeDir);
  const selection = resolveScopeSelection(raw, canonical.managedAgents);
  if (!selection.ok) return { name, action: "invalid-input", detail: selection.detail };

  const skill = canonical.skills.find((candidate) => candidate.name === name);
  if (!skill) return { name, action: "not-found", detail: `no canonical skill named "${name}"` };

  const base = {
    name,
    scope: selection.scope,
    mode: selection.mode,
    normalizedFromFull: selection.normalizedFromFull,
    effective: resolveScope(selection.scope, canonical.managedAgents),
  };
  const summary = describeScope(selection.scope, canonical.managedAgents);
  const normalized = selection.normalizedFromFull ? " (every managed agent selected — recorded as the default, so a newly managed agent is included)" : "";
  if (sameScope(skill.scope, selection.scope)) {
    return { ...base, action: "already-set", detail: `scope is already ${summary}` };
  }
  return { ...base, action: "updated", detail: `set scope to ${summary}${normalized}` };
}

export interface SkillScopeOutcome {
  plan: SkillScopePlan;
  writeError?: string;
  sync?: SyncReport;
}

/** Write inside a backup session so `trellis rollback` covers it, then the
 * same skills sync `add` / `remove` run — narrowing is converged by
 * `symlinkPlan`'s existing "canonical entry gone or scoped away" removal
 * (design.md D5). */
export async function applySkillScopeWithSync(plan: SkillScopePlan, opts: { homeDir?: string; dryRun?: boolean; backupSession?: BackupSession } = {}): Promise<SkillScopeOutcome> {
  const homeDir = opts.homeDir ?? homedir();
  const ownSession = !opts.dryRun && !opts.backupSession && plan.action === "updated" ? openBackupSession(homeDir, "skill-scope") : undefined;
  const session = opts.backupSession ?? ownSession;
  let writeError: string | undefined;
  if (!opts.dryRun && plan.action === "updated") {
    const result = writeSkillScopeYaml(join(homeDir, ".trellis", "scope.yaml"), plan.name, plan.scope, session);
    if (!result.ok) writeError = result.error;
  }
  ownSession?.finalize();
  let syncReport: SyncReport | undefined;
  if (!writeError && plan.action === "updated" && existsSync(join(homeDir, ".trellis"))) {
    syncReport = await collectSyncReport({ target: "skills", homeDir, dryRun: opts.dryRun });
  }
  return { plan, ...(writeError ? { writeError } : {}), ...(syncReport ? { sync: syncReport } : {}) };
}

export async function runSkillScope(name: string | undefined, raw: ScopeSelectorRaw, opts: { homeDir?: string; json?: boolean; dryRun?: boolean } = {}): Promise<{ exitCode: number }> {
  const homeDir = opts.homeDir ?? homedir();
  let outcome: SkillScopeOutcome;
  try {
    outcome = await applySkillScopeWithSync(collectSkillScopePlan(name, raw, homeDir), { homeDir, dryRun: opts.dryRun });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }
  const { plan, writeError, sync: syncReport } = outcome;
  if (opts.json) {
    const payload = writeError ? { ...plan, writeError } : plan;
    console.log(JSON.stringify(syncReport ? { ...payload, sync: syncReport } : payload, null, 2));
  } else {
    console.log(`${opts.dryRun ? "[dry run] " : ""}skill scope ${plan.name}`);
    console.log(`  [${plan.action}] ${plan.detail}`);
    if (writeError) console.error(`  write failed: ${writeError}`);
    if (syncReport) printSyncReport(syncReport, opts.dryRun ?? false);
  }
  const failed = plan.action === "invalid-input" || plan.action === "not-found" || Boolean(writeError);
  const syncConflict = syncReport?.reports.some((r) => r.items.some((i) => i.action === "conflict")) ?? false;
  return { exitCode: failed || syncConflict ? 1 : 0 };
}
