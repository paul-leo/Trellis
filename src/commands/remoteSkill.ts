/**
 * `trellis add` and `trellis update`: GitHub-hosted Skill import with
 * Trellis-owned canonical storage, provenance, scope, backup, and sync.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateSkillScopeYaml, writeSkillScopeYaml } from "../core/canonical.js";
import { loadCanonicalSource } from "../core/canonical.js";
import { ALL_AGENTS } from "../core/types.js";
import type { AgentId, Scope } from "../core/types.js";
import { decideDirImport } from "../lib/dirEquals.js";
import { directoryDigest } from "../lib/dirDigest.js";
import { openBackupSession, type BackupSession } from "../lib/backup.js";
import { isBuiltinSkillName } from "../lib/builtinSkills.js";
import { emptyRemoteSkillLock, readRemoteSkillLock, type RemoteSkillLock, type RemoteSkillLockEntry, writeRemoteSkillLock } from "../lib/remoteSkillLock.js";
import { fetchRemoteRepository, normalizeGitHubRepository, type FetchedRemoteRepository, type SelectedRemoteSkill } from "../lib/remoteSkillSource.js";
import { collectSyncReport, printReport as printSyncReport } from "./sync.js";
import type { SyncReport } from "./sync.js";

export type RemoteSkillAction = "create" | "already-present" | "conflict" | "invalid-source" | "invalid-options";

export interface RemoteSkillAddPlan {
  name: string;
  action: RemoteSkillAction;
  detail: string;
  source?: string;
  requestedRef?: string;
  commit?: string;
  subdirectory?: string;
  digest?: string;
  canonicalPath?: string;
  scope?: Scope;
  /** Present only in process memory; never included in CLI output. */
  sourceDir?: string;
}

export interface RemoteSkillAddOptions {
  branch?: string;
  agents?: readonly string[];
  homeDir?: string;
  dryRun?: boolean;
  json?: boolean;
}

function safeSkillName(name: string | undefined): name is string {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) && name !== "." && name !== "..";
}

function cloneLock(lock: RemoteSkillLock): RemoteSkillLock {
  return { version: lock.version, skills: Object.fromEntries(Object.entries(lock.skills).map(([name, entry]) => [name, { ...entry }])) };
}

function lockEntryFor(source: string, requestedRef: string, commit: string, selected: SelectedRemoteSkill): RemoteSkillLockEntry {
  return { source, requestedRef, commit, subdirectory: selected.subdirectory, digest: selected.digest };
}

function sameLockEntry(a: RemoteSkillLockEntry | undefined, b: RemoteSkillLockEntry): boolean {
  return a !== undefined
    && a.source === b.source
    && a.requestedRef === b.requestedRef
    && a.commit === b.commit
    && a.subdirectory === b.subdirectory
    && a.digest === b.digest;
}

function scopeForRequest(homeDir: string, agents: readonly string[] | undefined): { scope?: Scope; error?: string } {
  let canonical;
  try {
    canonical = loadCanonicalSource(homeDir);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!agents || agents.length === 0) return { scope: undefined };
  const values = agents.flatMap((value) => value.split(",").map((id) => id.trim()).filter(Boolean));
  if (values.length === 0) return { error: "--agent needs at least one Agent id" };
  if (values.includes("*")) {
    if (values.length !== 1) return { error: '--agent "*" cannot be combined with named Agents' };
    return { scope: [...canonical.managedAgents] };
  }
  const resolved: AgentId[] = [];
  for (const id of values) {
    if (!(ALL_AGENTS as readonly string[]).includes(id)) return { error: `Unknown Agent id: ${id}` };
    const agent = id as AgentId;
    if (!canonical.managedAgents.includes(agent)) return { error: `${agent} is not managed. Add it with \`trellis manage add ${agent}\` before targeting it.` };
    if (!resolved.includes(agent)) resolved.push(agent);
  }
  return { scope: resolved };
}

/** Builds an import plan from an already-fetched source.  Keeping fetching
 * outside this function makes the real Git transport testable with a local
 * bare repository while public CLI input remains GitHub-only. */
export function collectRemoteSkillAddPlan(
  fetched: FetchedRemoteRepository,
  name: string | undefined,
  opts: Omit<RemoteSkillAddOptions, "branch" | "dryRun" | "json"> = {},
): RemoteSkillAddPlan {
  const homeDir = opts.homeDir ?? homedir();
  if (!safeSkillName(name)) return { name: name ?? "", action: "invalid-options", detail: "--skill must be a safe Skill directory name" };
  if (isBuiltinSkillName(name)) return { name, action: "conflict", detail: `"${name}" is a Trellis package-owned Skill and cannot be replaced` };
  const scopeResult = scopeForRequest(homeDir, opts.agents);
  if (scopeResult.error) return { name, action: "invalid-options", detail: scopeResult.error };
  let selected: SelectedRemoteSkill;
  try {
    selected = fetched.select(name);
  } catch (error) {
    return { name, action: "invalid-source", detail: error instanceof Error ? error.message : String(error) };
  }
  const lockRead = readRemoteSkillLock(homeDir);
  if (!lockRead.ok) return { name, action: "conflict", detail: lockRead.error };
  const canonicalPath = join(homeDir, ".trellis", "skills", name);
  const incoming = lockEntryFor(fetched.repository.url, fetched.requestedRef, fetched.commit, selected);
  const existingLock = lockRead.lock.skills[name];
  const decision = decideDirImport(selected.directory, canonicalPath);
  if (decision === "conflict") {
    return { name, action: "conflict", detail: `canonical skills/${name}/ already exists with different content — resolve it by hand`, canonicalPath, scope: scopeResult.scope };
  }
  if (decision === "already-present") {
    if (!sameLockEntry(existingLock, incoming)) {
      return { name, action: "conflict", detail: `canonical skills/${name}/ already exists without matching remote provenance — resolve it by hand`, canonicalPath, scope: scopeResult.scope };
    }
    return { name, action: "already-present", detail: "canonical content and remote provenance are already current", source: incoming.source, requestedRef: incoming.requestedRef, commit: incoming.commit, subdirectory: incoming.subdirectory, digest: incoming.digest, canonicalPath, scope: scopeResult.scope };
  }
  if (existingLock) {
    return { name, action: "conflict", detail: `provenance already tracks ${name} but its canonical directory is absent — resolve it by hand`, canonicalPath, scope: scopeResult.scope };
  }
  return { name, action: "create", detail: `will import ${incoming.subdirectory} at ${incoming.commit}`, source: incoming.source, requestedRef: incoming.requestedRef, commit: incoming.commit, subdirectory: incoming.subdirectory, digest: incoming.digest, canonicalPath, scope: scopeResult.scope, sourceDir: selected.directory };
}

function successfulAdd(plan: RemoteSkillAddPlan): boolean {
  return plan.action === "create" || plan.action === "already-present";
}

function displayAddPlan(plan: RemoteSkillAddPlan): Omit<RemoteSkillAddPlan, "sourceDir"> {
  const { sourceDir: _sourceDir, ...safe } = plan;
  return safe;
}

export interface RemoteSkillAddOutcome {
  plan: Omit<RemoteSkillAddPlan, "sourceDir">;
  sync?: SyncReport;
}

export async function applyRemoteSkillAddPlan(plan: RemoteSkillAddPlan, opts: { homeDir?: string; dryRun?: boolean; backupSession?: BackupSession } = {}): Promise<RemoteSkillAddOutcome> {
  const homeDir = opts.homeDir ?? homedir();
  if (!successfulAdd(plan)) return { plan: displayAddPlan(plan) };
  if (opts.dryRun) return { plan: displayAddPlan(plan) };

  const ownSession = !opts.backupSession ? openBackupSession(homeDir, "remote-skill-add") : undefined;
  const session: BackupSession = opts.backupSession ?? ownSession!;
  if (plan.action === "create") {
    const scopePath = join(homeDir, ".trellis", "scope.yaml");
    const scopeValidation = validateSkillScopeYaml(scopePath);
    if (!scopeValidation.ok) throw new Error(scopeValidation.error);
    const lockRead = readRemoteSkillLock(homeDir);
    if (!lockRead.ok) throw new Error(lockRead.error);
    session.createDirFromSource(plan.canonicalPath!, plan.sourceDir!);
    const scopeWrite = writeSkillScopeYaml(scopePath, plan.name, plan.scope, session);
    if (!scopeWrite.ok) throw new Error(scopeWrite.error);
    const lock = cloneLock(lockRead.lock);
    lock.skills[plan.name] = {
      source: plan.source!, requestedRef: plan.requestedRef!, commit: plan.commit!, subdirectory: plan.subdirectory!, digest: plan.digest!,
    };
    writeRemoteSkillLock(homeDir, lock, session);
  } else {
    // An idempotent add may still deliberately change scope.  The writer is
    // no-op when it already matches, so it does not create a needless backup.
    const scopeWrite = writeSkillScopeYaml(join(homeDir, ".trellis", "scope.yaml"), plan.name, plan.scope, session);
    if (!scopeWrite.ok) throw new Error(scopeWrite.error);
  }
  ownSession?.finalize();
  let sync: SyncReport | undefined;
  if (session.hasOperations() && existsSync(join(homeDir, ".trellis"))) {
    sync = await collectSyncReport({ target: "skills", homeDir });
  }
  return { plan: displayAddPlan(plan), ...(sync ? { sync } : {}) };
}

/** CLI-facing remote add.  The only source accepted here is normalized
 * GitHub input; tests use collectRemoteSkillAddPlan with a local fetch. */
export async function runRemoteSkillAdd(sourceInput: string | undefined, name: string | undefined, opts: RemoteSkillAddOptions = {}): Promise<{ exitCode: number }> {
  let repository;
  try {
    repository = normalizeGitHubRepository(sourceInput ?? "");
  } catch (error) {
    const plan: RemoteSkillAddPlan = { name: name ?? "", action: "invalid-source", detail: error instanceof Error ? error.message : String(error) };
    if (opts.json) console.log(JSON.stringify(displayAddPlan(plan), null, 2));
    else console.error(plan.detail);
    return { exitCode: 1 };
  }
  let fetched: FetchedRemoteRepository;
  try {
    fetched = fetchRemoteRepository(repository, { branch: opts.branch });
  } catch (error) {
    const plan: RemoteSkillAddPlan = { name: name ?? "", action: "invalid-source", detail: error instanceof Error ? error.message : String(error), source: repository.url };
    if (opts.json) console.log(JSON.stringify(displayAddPlan(plan), null, 2));
    else console.error(plan.detail);
    return { exitCode: 1 };
  }
  try {
    const plan = collectRemoteSkillAddPlan(fetched, name, opts);
    const outcome = await applyRemoteSkillAddPlan(plan, { homeDir: opts.homeDir, dryRun: opts.dryRun });
    if (opts.json) {
      console.log(JSON.stringify(outcome, null, 2));
    } else {
      console.log(`${opts.dryRun ? "[dry run] " : ""}remote skill add ${plan.name}`);
      console.log(`  [${plan.action}] ${plan.detail}`);
      if (plan.source) console.log(`  source: ${plan.source}@${plan.commit} (${plan.subdirectory})`);
      if (plan.canonicalPath) console.log(`  canonical: ${plan.canonicalPath}`);
      if (plan.scope !== undefined) console.log(`  scope: ${plan.scope.join(", ") || "(no managed agents)"}`);
      if (outcome.sync) printSyncReport(outcome.sync, false);
    }
    const syncConflict = outcome.sync?.reports.some((report) => report.items.some((item) => item.action === "conflict")) ?? false;
    return { exitCode: successfulAdd(plan) && !syncConflict ? 0 : 1 };
  } finally {
    fetched.dispose();
  }
}

export async function runRemoteSkillList(sourceInput: string | undefined, opts: { branch?: string; json?: boolean } = {}): Promise<{ exitCode: number }> {
  let repository;
  try {
    repository = normalizeGitHubRepository(sourceInput ?? "");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (opts.json) console.log(JSON.stringify({ action: "invalid-source", detail }, null, 2)); else console.error(detail);
    return { exitCode: 1 };
  }
  try {
    const fetched = fetchRemoteRepository(repository, { branch: opts.branch });
    try {
      const report = { source: repository.url, requestedRef: fetched.requestedRef, commit: fetched.commit, skills: fetched.candidates.map(({ name, subdirectory }) => ({ name, subdirectory })) };
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else if (report.skills.length === 0) console.log("No exact-case SKILL.md entries found in the remote source.");
      else for (const skill of report.skills) console.log(`${skill.name} — ${skill.subdirectory}`);
      return { exitCode: 0 };
    } finally {
      fetched.dispose();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (opts.json) console.log(JSON.stringify({ action: "invalid-source", detail, source: repository.url }, null, 2)); else console.error(detail);
    return { exitCode: 1 };
  }
}

export type RemoteSkillUpdateAction = "already-current" | "update" | "conflict" | "not-tracked" | "invalid-source";

export interface RemoteSkillUpdatePlan {
  name: string;
  action: RemoteSkillUpdateAction;
  detail: string;
  source?: string;
  requestedRef?: string;
  previousCommit?: string;
  commit?: string;
  previousDigest?: string;
  digest?: string;
  canonicalPath?: string;
  sourceDir?: string;
  replaceDirectory?: boolean;
}

function displayUpdatePlan(plan: RemoteSkillUpdatePlan): Omit<RemoteSkillUpdatePlan, "sourceDir"> {
  const { sourceDir: _sourceDir, ...safe } = plan;
  return safe;
}

export function collectRemoteSkillUpdatePlan(name: string, fetched: FetchedRemoteRepository | undefined, homeDir: string = homedir()): RemoteSkillUpdatePlan {
  const lockRead = readRemoteSkillLock(homeDir);
  if (!lockRead.ok) return { name, action: "conflict", detail: lockRead.error };
  const entry = lockRead.lock.skills[name];
  if (!entry) return { name, action: "not-tracked", detail: `${name} is not a remotely tracked Skill` };
  const canonicalPath = join(homeDir, ".trellis", "skills", name);
  if (!existsSync(canonicalPath)) return { name, action: "conflict", detail: `canonical skills/${name}/ is missing while provenance remains`, canonicalPath };
  let currentDigest: string;
  try {
    currentDigest = directoryDigest(canonicalPath);
  } catch (error) {
    return { name, action: "conflict", detail: `could not read canonical skills/${name}/ safely: ${error instanceof Error ? error.message : String(error)}`, canonicalPath };
  }
  if (currentDigest !== entry.digest) {
    return { name, action: "conflict", detail: `canonical skills/${name}/ has local edits and will not be overwritten`, source: entry.source, requestedRef: entry.requestedRef, previousCommit: entry.commit, previousDigest: entry.digest, canonicalPath };
  }
  if (!fetched) return { name, action: "invalid-source", detail: "Remote source was not fetched", source: entry.source, requestedRef: entry.requestedRef, previousCommit: entry.commit, previousDigest: entry.digest, canonicalPath };
  let selected: SelectedRemoteSkill;
  try {
    selected = fetched.select(name);
  } catch (error) {
    return { name, action: "invalid-source", detail: error instanceof Error ? error.message : String(error), source: entry.source, requestedRef: entry.requestedRef, previousCommit: entry.commit, previousDigest: entry.digest, canonicalPath };
  }
  if (selected.subdirectory !== entry.subdirectory) {
    return { name, action: "conflict", detail: `remote Skill ${name} moved from ${entry.subdirectory} to ${selected.subdirectory}; resolve provenance by hand`, source: entry.source, requestedRef: entry.requestedRef, previousCommit: entry.commit, previousDigest: entry.digest, canonicalPath };
  }
  if (fetched.commit === entry.commit && selected.digest === entry.digest) {
    return { name, action: "already-current", detail: "remote commit and canonical content are already current", source: entry.source, requestedRef: entry.requestedRef, previousCommit: entry.commit, commit: fetched.commit, previousDigest: entry.digest, digest: selected.digest, canonicalPath };
  }
  return { name, action: "update", detail: `will update ${entry.commit} -> ${fetched.commit}`, source: entry.source, requestedRef: entry.requestedRef, previousCommit: entry.commit, commit: fetched.commit, previousDigest: entry.digest, digest: selected.digest, canonicalPath, sourceDir: selected.directory, replaceDirectory: selected.digest !== entry.digest };
}

export interface RemoteSkillUpdateOutcome {
  plans: readonly Omit<RemoteSkillUpdatePlan, "sourceDir">[];
  sync?: SyncReport;
}

export async function applyRemoteSkillUpdatePlans(plans: readonly RemoteSkillUpdatePlan[], opts: { homeDir?: string; dryRun?: boolean; backupSession?: BackupSession } = {}): Promise<RemoteSkillUpdateOutcome> {
  const homeDir = opts.homeDir ?? homedir();
  const updates = plans.filter((plan) => plan.action === "update");
  if (opts.dryRun || updates.length === 0) return { plans: plans.map(displayUpdatePlan) };
  const ownSession = !opts.backupSession ? openBackupSession(homeDir, "remote-skill-update") : undefined;
  const session: BackupSession = opts.backupSession ?? ownSession!;
  const lockRead = readRemoteSkillLock(homeDir);
  if (!lockRead.ok) throw new Error(lockRead.error);
  const lock = cloneLock(lockRead.lock);
  // Recheck all mutable inputs before the first replacement. The plans may
  // have been previewed some time before application, so no remote update
  // should proceed if either the lock or canonical directory changed.
  for (const plan of updates) {
    const current = lock.skills[plan.name];
    if (!current || current.commit !== plan.previousCommit || current.digest !== plan.previousDigest) {
      throw new Error(`Remote Skill ${plan.name} provenance changed after planning; run \`trellis update\` again.`);
    }
    if (directoryDigest(plan.canonicalPath!) !== plan.previousDigest) {
      throw new Error(`Canonical Skill ${plan.name} changed after planning; run \`trellis update\` again.`);
    }
  }
  for (const plan of updates) {
    if (plan.replaceDirectory) session.replaceDirFromSource(plan.canonicalPath!, plan.sourceDir!);
    lock.skills[plan.name] = { source: plan.source!, requestedRef: plan.requestedRef!, commit: plan.commit!, subdirectory: lock.skills[plan.name]!.subdirectory, digest: plan.digest! };
  }
  writeRemoteSkillLock(homeDir, lock, session);
  ownSession?.finalize();
  let sync: SyncReport | undefined;
  if (session.hasOperations() && existsSync(join(homeDir, ".trellis"))) sync = await collectSyncReport({ target: "skills", homeDir });
  return { plans: plans.map(displayUpdatePlan), ...(sync ? { sync } : {}) };
}

export async function runRemoteSkillUpdate(names: readonly string[], opts: { homeDir?: string; dryRun?: boolean; json?: boolean } = {}): Promise<{ exitCode: number }> {
  const homeDir = opts.homeDir ?? homedir();
  const lockRead = readRemoteSkillLock(homeDir);
  const selectedNames = names.length > 0 ? [...new Set(names)] : lockRead.ok ? Object.keys(lockRead.lock.skills).sort() : [];
  if (!lockRead.ok) {
    const report = [{ name: "", action: "conflict", detail: lockRead.error }];
    if (opts.json) console.log(JSON.stringify({ plans: report }, null, 2)); else console.error(lockRead.error);
    return { exitCode: 1 };
  }
  if (selectedNames.length === 0) {
    const report = { plans: [] as RemoteSkillUpdatePlan[] };
    if (opts.json) console.log(JSON.stringify(report, null, 2)); else console.log("No remotely tracked Skills to update.");
    return { exitCode: 0 };
  }
  const fetched = new Map<string, FetchedRemoteRepository>();
  const plans: RemoteSkillUpdatePlan[] = [];
  try {
    for (const name of selectedNames) {
      const entry = lockRead.lock.skills[name];
      if (!entry) {
        plans.push(collectRemoteSkillUpdatePlan(name, undefined, homeDir));
        continue;
      }
      // Avoid network work when the canonical tree has been edited: its plan
      // is already a safe conflict and must never be overwritten.
      const preliminary = collectRemoteSkillUpdatePlan(name, undefined, homeDir);
      if (preliminary.action === "conflict") {
        plans.push(preliminary);
        continue;
      }
      try {
        const repository = fetchRemoteRepository({ url: entry.source }, { branch: entry.requestedRef });
        fetched.set(name, repository);
        plans.push(collectRemoteSkillUpdatePlan(name, repository, homeDir));
      } catch (error) {
        plans.push({ name, action: "invalid-source", detail: error instanceof Error ? error.message : String(error), source: entry.source, requestedRef: entry.requestedRef, previousCommit: entry.commit, previousDigest: entry.digest, canonicalPath: join(homeDir, ".trellis", "skills", name) });
      }
    }
    // Multiple requested updates behave as a safe batch: a bad tracked Skill
    // does not leave the rest unexpectedly changed in the same command.
    const blocked = plans.some((plan) => plan.action === "conflict" || plan.action === "not-tracked" || plan.action === "invalid-source");
    const outcome = blocked ? { plans: plans.map(displayUpdatePlan) } : await applyRemoteSkillUpdatePlans(plans, { homeDir, dryRun: opts.dryRun });
    if (opts.json) {
      console.log(JSON.stringify(outcome, null, 2));
    } else {
      if (opts.dryRun) console.log("[dry run]");
      for (const plan of plans) console.log(`update ${plan.name}: [${plan.action}] ${plan.detail}`);
      if (outcome.sync) printSyncReport(outcome.sync, false);
    }
    const syncConflict = outcome.sync?.reports.some((report) => report.items.some((item) => item.action === "conflict")) ?? false;
    return { exitCode: blocked || syncConflict ? 1 : 0 };
  } finally {
    for (const repository of fetched.values()) repository.dispose();
  }
}

/** Used by Skill listing to distinguish remote provenance from local content
 * without making a malformed bookkeeping file crash a read-only list. */
export function remoteSkillProvenance(homeDir: string): Record<string, RemoteSkillLockEntry> {
  const lock = readRemoteSkillLock(homeDir);
  return lock.ok ? lock.lock.skills : emptyRemoteSkillLock().skills;
}
