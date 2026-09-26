/** Durable provenance for remote Skills in ~/.trellis/skills.lock.json. */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BackupSession } from "./backup.js";

export const REMOTE_SKILL_LOCK_VERSION = 1;

export interface RemoteSkillLockEntry {
  source: string;
  requestedRef: string;
  commit: string;
  subdirectory: string;
  digest: string;
}

export interface RemoteSkillLock {
  version: typeof REMOTE_SKILL_LOCK_VERSION;
  skills: Record<string, RemoteSkillLockEntry>;
}

export type RemoteSkillLockRead = { ok: true; lock: RemoteSkillLock } | { ok: false; error: string };

export function remoteSkillLockPath(homeDir: string): string {
  return join(homeDir, ".trellis", "skills.lock.json");
}

export function emptyRemoteSkillLock(): RemoteSkillLock {
  return { version: REMOTE_SKILL_LOCK_VERSION, skills: {} };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSource(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.hostname === "github.com"
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash
      && /^\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+\.git$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function validEntry(value: unknown): value is RemoteSkillLockEntry {
  if (!isObject(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "commit,digest,requestedRef,source,subdirectory") return false;
  return validSource(value.source)
    && typeof value.requestedRef === "string" && value.requestedRef.length > 0 && !/[\0\r\n]/.test(value.requestedRef)
    && typeof value.commit === "string" && /^[0-9a-f]{40}$/.test(value.commit)
    && typeof value.subdirectory === "string" && value.subdirectory.length > 0 && !value.subdirectory.startsWith("/") && !value.subdirectory.split("/").includes("..")
    && typeof value.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(value.digest);
}

function validateLock(value: unknown): RemoteSkillLock {
  if (!isObject(value) || value.version !== REMOTE_SKILL_LOCK_VERSION || !isObject(value.skills) || Object.keys(value).some((key) => key !== "version" && key !== "skills")) {
    throw new Error("expected version 1 and a skills object");
  }
  const skills: Record<string, RemoteSkillLockEntry> = {};
  for (const [name, entry] of Object.entries(value.skills)) {
    if (!name || name.includes("/") || name.includes("\\") || !validEntry(entry)) {
      throw new Error(`invalid provenance entry for Skill ${JSON.stringify(name)}`);
    }
    skills[name] = entry;
  }
  return { version: REMOTE_SKILL_LOCK_VERSION, skills };
}

export function readRemoteSkillLock(homeDir: string): RemoteSkillLockRead {
  const path = remoteSkillLockPath(homeDir);
  try {
    if (!existsSync(path)) return { ok: true, lock: emptyRemoteSkillLock() };
    return { ok: true, lock: validateLock(JSON.parse(readFileSync(path, "utf8")) as unknown) };
  } catch (error) {
    return { ok: false, error: `Cannot use ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function serializeRemoteSkillLock(lock: RemoteSkillLock): string {
  const valid = validateLock(lock);
  const skills = Object.fromEntries(Object.entries(valid.skills).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify({ version: REMOTE_SKILL_LOCK_VERSION, skills }, null, 2)}\n`;
}

export function writeRemoteSkillLock(homeDir: string, lock: RemoteSkillLock, backup?: BackupSession): void {
  const path = remoteSkillLockPath(homeDir);
  const content = serializeRemoteSkillLock(lock);
  mkdirSync(dirname(path), { recursive: true });
  if (backup) {
    backup.writeFile(path, content);
    return;
  }
  const temporary = join(dirname(path), `.${path.split("/").pop()}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
