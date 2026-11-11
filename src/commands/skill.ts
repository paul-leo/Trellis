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
import { decideDirImport } from "../lib/dirEquals.js";
import { findSkillFile } from "../lib/skillFile.js";
import { loadCanonicalSource, validateSkillScopeYaml, writeSkillScopeYaml } from "../core/canonical.js";
import { resolveScope } from "../core/types.js";
import type { AgentId } from "../core/types.js";
import { BUILTIN_SKILL_NAMES, isBuiltinSkillName, readBuiltinSkillFiles, TRELLIS_RUNTIME_SKILL_NAME, type BuiltinSkillName } from "../lib/builtinSkills.js";
import { openBackupSession, type BackupSession } from "../lib/backup.js";
import { collectSyncReport, printReport as printSyncReport } from "./sync.js";
import type { SyncReport } from "./sync.js";
import { remoteSkillProvenance } from "./remoteSkill.js";
import { sameScope, type ScopeSelectorRaw } from "../lib/scopeSelection.js";
import type { RemoteSkillLockEntry } from "../lib/remoteSkillLock.js";
import { findWorkspaceRoot } from "../lib/workspace.js";
import { readSkillScopes, requestSkillScope, selectSkillScope } from "../lib/skillScope.js";
import { isSymlinkTo } from "../lib/fsIdentity.js";
import { usesNativeCapabilityDelivery, ALL_AGENTS } from "../core/types.js";

export type BuiltinSkillUpdateAction = "create" | "update" | "already-current";

export interface BuiltinSkillUpdatePlan {
  name: BuiltinSkillName;
  action: BuiltinSkillUpdateAction;
  detail: string;
  path: string;
}

export function collectBuiltinSkillUpdatePlan(homeDir: string = homedir(), name: BuiltinSkillName = TRELLIS_RUNTIME_SKILL_NAME): BuiltinSkillUpdatePlan {
  const path = join(homeDir, ".trellis", "skills", name, "SKILL.md");
  if (!existsSync(path)) return { name, action: "create", detail: `will install the package-owned ${name} Skill`, path };
  if (readBuiltinSkillFiles(name).every((file) => {
    const target = join(homeDir, ".trellis", "skills", name, file.relativePath);
    return existsSync(target) && readFileSync(target, "utf8") === file.content;
  })) return { name, action: "already-current", detail: `package-owned ${name} Skill is already current`, path };
  return { name, action: "update", detail: `will refresh the package-owned ${name} Skill; existing Agent symlinks will see the update`, path };
}

export function applyBuiltinSkillUpdatePlan(plan: BuiltinSkillUpdatePlan, backup?: BackupSession): void {
  if (plan.action === "already-current") return;
  for (const file of readBuiltinSkillFiles(plan.name)) {
    const target = join(dirname(plan.path), file.relativePath);
    mkdirSync(dirname(target), { recursive: true });
    if (backup) backup.writeFile(target, file.content);
    else writeFileSync(target, file.content);
  }
}

export function runSkillUpdateBuiltin(opts: { homeDir?: string; json?: boolean; dryRun?: boolean } = {}): { exitCode: number } {
  const homeDir = opts.homeDir ?? homedir();
  const plans = BUILTIN_SKILL_NAMES.map((name) => collectBuiltinSkillUpdatePlan(homeDir, name));
  if (!opts.dryRun && plans.some((plan) => plan.action !== "already-current")) {
    const backup = openBackupSession(homeDir, "skill-update-builtin");
    for (const plan of plans) applyBuiltinSkillUpdatePlan(plan, backup);
    backup.finalize();
  }
  // Preserve the original top-level Runtime plan for existing JSON consumers.
  if (opts.json) console.log(JSON.stringify({ ...plans[0], skills: plans }, null, 2));
  else console.log(`${opts.dryRun ? "[dry run] " : ""}skill update-builtin\n${plans.map((plan) => `  [${plan.action}] ${plan.detail}`).join("\n")}`);
  return { exitCode: 0 };
}

export interface SkillListEntry {
  name: string;
  scope: readonly AgentId[];
  registered?: boolean;
  delivery?: { state: "linked" | "missing" | "conflict" | "runtime"; path?: string };
  remote?: Pick<RemoteSkillLockEntry, "source" | "requestedRef" | "commit" | "subdirectory" | "digest">;
}

export function collectSkillList(homeDir: string = homedir(), agent?: AgentId): SkillListEntry[] {
  const canonical = loadCanonicalSource(homeDir);
  const provenance = remoteSkillProvenance(homeDir);
  const registry = readSkillScopes(join(homeDir, ".trellis", "scope.yaml"));
  const roots: Record<AgentId, string> = {
    "claude-code": join(homeDir, ".claude", "skills"), codex: join(homeDir, ".agents", "skills"),
    kiro: join(homeDir, ".kiro", "skills"), pi: join(homeDir, ".pi", "agent", "skills"),
    "kimi-code": join(homeDir, ".kimi-code", "skills"), zcode: "",
  };
  return canonical.skills.filter((skill) => agent ? resolveScope(skill.scope, canonical.managedAgents).includes(agent) : !isBuiltinSkillName(skill.name)).map((skill) => ({
    name: skill.name,
    scope: resolveScope(skill.scope, canonical.managedAgents),
    ...(agent ? {
      registered: Object.hasOwn(registry, skill.name) || isBuiltinSkillName(skill.name),
      delivery: !usesNativeCapabilityDelivery(agent, canonical.mcp) || agent === "zcode"
        ? { state: "runtime" as const }
        : { state: isSymlinkTo(join(roots[agent], skill.name), skill.dir) ? "linked" as const
          : existsSync(join(roots[agent], skill.name)) ? "conflict" as const : "missing" as const, path: join(roots[agent], skill.name) },
    } : {}),
    ...(provenance[skill.name] ? { remote: provenance[skill.name] } : {}),
  }));
}

export function runSkillList(opts: { homeDir?: string; json?: boolean; agent?: string } = {}): { exitCode: number } {
  if (opts.agent !== undefined && !(ALL_AGENTS as readonly string[]).includes(opts.agent)) {
    console.error(`unknown agent: ${opts.agent}; choose ${ALL_AGENTS.join(", ")}`);
    return { exitCode: 1 };
  }
  const entries = collectSkillList(opts.homeDir ?? homedir(), opts.agent as AgentId | undefined);
  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2));
  } else if (entries.length === 0) {
    console.log("No skills in canonical source yet.");
  } else {
    for (const { name, scope, remote, delivery } of entries) {
      const provenance = remote ? ` — remote: ${remote.source}@${remote.commit.slice(0, 12)}` : "";
      console.log(`${name} — ${scope.length > 0 ? scope.join(", ") : "(paused: no applicable managed agent)"}${delivery ? ` [${delivery.state}]` : ""}${provenance}`);
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
  scope?: AgentId[];
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
  if (plan.action !== "create" && !(plan.action === "already-present" && plan.scope !== undefined)) return;
  if (plan.action === "create" && !plan.sourceDir) return;
  const scopePath = join(homeDir, ".trellis", "scope.yaml");
  const validation = validateSkillScopeYaml(scopePath);
  if (!validation.ok) throw new Error(validation.error);
  const dest = join(homeDir, ".trellis", "skills", plan.name);
  if (plan.action === "create") {
    if (backup) backup.createDirFromSource(dest, plan.sourceDir!);
    else {
      mkdirSync(dest, { recursive: true });
      cpSync(plan.sourceDir!, dest, { recursive: true });
    }
  }
  const written = writeSkillScopeYaml(scopePath, plan.name, plan.scope ?? [], backup);
  if (!written.ok) throw new Error(written.error);
}

/** The workspace twin of `collectSkillAddPlan` (trellis-workspace-scope
 * task 3.4): same source validation, destination is `.agents/skills/`
 * instead of the global canonical skills dir. */
export function collectSkillAddWorkspacePlan(name: string, fromPath: string, workspaceRoot: string): SkillAddPlan {
  const skillFile = findSkillFile(fromPath);
  if (!skillFile) {
    return { name, action: "invalid-source", detail: `${fromPath} has no SKILL.md` };
  }
  if (!skillFile.caseCorrect) {
    return { name, action: "invalid-source", detail: `${fromPath} has skill.md, not case-correct SKILL.md — fix the case first` };
  }

  const dest = join(workspaceRoot, ".agents", "skills", name);
  switch (decideDirImport(fromPath, dest)) {
    case "create":
      return { name, action: "create", detail: `will copy from ${fromPath} into .agents/skills/`, sourceDir: fromPath };
    case "already-present":
      return { name, action: "already-present", detail: ".agents/skills/ content is already byte-identical" };
    case "conflict":
      return { name, action: "conflict", detail: `.agents/skills/${name}/ already exists with different content — resolve by hand` };
  }
}

export function applySkillAddWorkspacePlan(plan: SkillAddPlan, workspaceRoot: string, backup?: BackupSession): void {
  if (plan.action !== "create" && !(plan.action === "already-present" && plan.scope !== undefined)) return;
  if (plan.action === "create" && !plan.sourceDir) return;
  const scopePath = join(workspaceRoot, ".agents", "scope.yaml");
  const validation = validateSkillScopeYaml(scopePath);
  if (!validation.ok) throw new Error(validation.error);
  const dest = join(workspaceRoot, ".agents", "skills", plan.name);
  if (plan.action === "create") {
    if (backup) backup.createDirFromSource(dest, plan.sourceDir!);
    else {
      mkdirSync(dest, { recursive: true });
      cpSync(plan.sourceDir!, dest, { recursive: true });
    }
  }
  const written = writeSkillScopeYaml(scopePath, plan.name, plan.scope ?? [], backup);
  if (!written.ok) throw new Error(written.error);
}

/** Same own-backup-session + cascade-sync posture as
 * `applySkillAddWithSync`, scoped to the workspace layer. */
export async function applySkillAddWorkspaceWithSync(plan: SkillAddPlan, workspaceRoot: string, opts: { homeDir?: string; dryRun?: boolean; backupSession?: BackupSession } = {}): Promise<SkillAddOutcome> {
  const homeDir = opts.homeDir ?? homedir();
  const ownSession = !opts.dryRun && !opts.backupSession && (plan.action === "create" || plan.action === "already-present" && plan.scope !== undefined) ? openBackupSession(homeDir, "skill-add") : undefined;
  const session = opts.backupSession ?? ownSession;
  if (!opts.dryRun && (plan.action === "create" || plan.action === "already-present")) {
    applySkillAddWorkspacePlan(plan, workspaceRoot, session);
  }
  ownSession?.finalize();
  const failed = plan.action === "conflict" || plan.action === "invalid-source";
  let syncReport: SyncReport | undefined;
  if (!failed && (plan.action === "create" || plan.scope !== undefined) && existsSync(join(homeDir, ".trellis"))) {
    syncReport = await collectSyncReport({ target: "skills", homeDir, workspaceDir: workspaceRoot, dryRun: opts.dryRun });
  }
  return { plan, ...(syncReport ? { sync: syncReport } : {}) };
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
  const ownSession = !opts.dryRun && !opts.backupSession && (plan.action === "create" || plan.action === "already-present" && plan.scope !== undefined) ? openBackupSession(homeDir, "skill-add") : undefined;
  const session = opts.backupSession ?? ownSession;
  if (!opts.dryRun && (plan.action === "create" || plan.action === "already-present")) {
    applySkillAddPlan(plan, homeDir, session);
  }
  ownSession?.finalize();
  const failed = plan.action === "conflict" || plan.action === "invalid-source";
  let syncReport: SyncReport | undefined;
  if (!failed && (plan.action === "create" || plan.scope !== undefined) && existsSync(join(homeDir, ".trellis"))) {
    syncReport = await collectSyncReport({ target: "skills", homeDir, dryRun: opts.dryRun });
  }
  return { plan, ...(syncReport ? { sync: syncReport } : {}) };
}

export async function runSkillAdd(name: string, fromPath: string, opts: { homeDir?: string; json?: boolean; dryRun?: boolean; workspace?: boolean; workspaceDir?: string; selection?: ScopeSelectorRaw } = {}): Promise<{ exitCode: number }> {
  const homeDir = opts.homeDir ?? homedir();
  const managed = existsSync(join(homeDir, ".trellis")) ? loadCanonicalSource(homeDir).managedAgents : [];
  const selected = await requestSkillScope(opts.selection ?? {}, managed, !opts.json);
  if ("error" in selected) {
    if (opts.json) console.log(JSON.stringify({ name, action: "invalid-source", detail: selected.error }));
    else console.error(selected.error);
    return { exitCode: 1 };
  }

  if (opts.workspace) {
    const workspaceRoot = opts.workspaceDir ?? findWorkspaceRoot(process.cwd());
    if (!workspaceRoot) {
      console.error("no .agents/ found here or above — run `trellis init --workspace` first (or pass --workspace from inside the repo)");
      return { exitCode: 1 };
    }
    const plan = collectSkillAddWorkspacePlan(name, fromPath, workspaceRoot);
    plan.scope = selected.scope;
    const { sync: syncReport } = await applySkillAddWorkspaceWithSync(plan, workspaceRoot, { homeDir, dryRun: opts.dryRun });
    const failed = plan.action === "conflict" || plan.action === "invalid-source";
    if (opts.json) {
      console.log(JSON.stringify(syncReport ? { ...plan, workspace: workspaceRoot, sync: syncReport } : { ...plan, workspace: workspaceRoot }, null, 2));
    } else {
      console.log(`${opts.dryRun ? "[dry run] " : ""}skill add ${name} --workspace`);
      console.log(`  [${plan.action}] ${plan.detail}`);
      if (syncReport) printSyncReport(syncReport, opts.dryRun ?? false);
    }
    const syncConflict = syncReport?.reports.some((r) => r.items.some((i) => i.action === "conflict")) ?? false;
    return { exitCode: failed || syncConflict ? 1 : 0 };
  }

  const plan = collectSkillAddPlan(name, fromPath, homeDir);
  plan.scope = selected.scope;
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
  /** Applicable agents recorded in scope.yaml. Even --all is a fixed list. */
  scope?: AgentId[];
  mode?: "all" | "none" | "explicit";
  /** Retained for API compatibility; skill lists are never normalized away. */
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
  const chosen = selectSkillScope(raw, canonical.managedAgents);
  if ("error" in chosen) return { name, action: "invalid-input", detail: chosen.error };
  const selection = { scope: chosen.scope, mode: raw.all ? "all" as const : raw.none ? "none" as const : "explicit" as const, normalizedFromFull: false };

  const skill = canonical.skills.find((candidate) => candidate.name === name);
  if (!skill) return { name, action: "not-found", detail: `no canonical skill named "${name}"` };

  const base = {
    name,
    scope: selection.scope,
    mode: selection.mode,
    normalizedFromFull: selection.normalizedFromFull,
    effective: resolveScope(selection.scope, canonical.managedAgents),
  };
  const summary = selection.scope.length ? selection.scope.join(", ") : "no agent (paused)";
  if (sameScope(skill.scope, selection.scope) && Object.hasOwn(readSkillScopes(join(homeDir, ".trellis", "scope.yaml")), name)) {
    return { ...base, action: "already-set", detail: `scope is already ${summary}` };
  }
  return { ...base, action: "updated", detail: `set scope to ${summary}` };
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
