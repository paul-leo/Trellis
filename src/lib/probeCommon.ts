/**
 * Shared filesystem/JSON reading used by every per-agent probe
 * (src/probes/*.ts) — kept here so all four agree on what "symlink status,"
 * "skill root," and "resolve env var references" mean, rather than each
 * probe reimplementing it slightly differently.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { findSkillFile } from "./skillFile.js";
import type {
  AgentSnapshotPathRef,
  AgentSnapshotSkillEntry,
  AgentSnapshotSkillRoot,
} from "../core/types.js";

export function pathRef(path: string): AgentSnapshotPathRef | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  if (!lstatSync(path).isSymbolicLink()) {
    return { path, isSymlink: false };
  }
  try {
    return { path, isSymlink: true, target: realpathSync(path) };
  } catch {
    return { path, isSymlink: true };
  }
}

/**
 * One skill root = a directory of skill subdirectories, each expected to
 * hold `SKILL.md`. Every agent as of design.md D5 uses this shape.
 */
export function scanSkillRoot(rootPath: string): AgentSnapshotSkillRoot | undefined {
  const ref = pathRef(rootPath);
  if (!ref) {
    return undefined;
  }

  const skills: AgentSnapshotSkillEntry[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(rootPath);
  } catch {
    entries = [];
  }

  for (const name of entries) {
    const dir = join(rootPath, name);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDirectory) {
      continue;
    }

    const skillFile = findSkillFile(dir);
    if (!skillFile) {
      continue;
    }

    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      realDir = dir;
    }

    skills.push({
      name,
      dir,
      realDir,
      isSymlink: lstatSync(dir).isSymbolicLink(),
      caseCorrect: skillFile.caseCorrect,
    });
  }

  return { path: rootPath, isSymlink: ref.isSymlink, target: ref.target, skills };
}

export function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

export function countDirEntries(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

/**
 * Substitutes `${VAR}` against `base` (normally `process.env`) so a
 * probe's handshake spawn gets the real value — configs only ever hold
 * the variable NAME (docs/research.md "Secrets"), never a literal.
 * Values given as a bare array (Codex's `env_vars` style: just names) need
 * no substitution — the named var must already be in `base` for the
 * spawned process to inherit it, which it will via object spread.
 */
export function resolveEnvRefs(
  envSpec: Record<string, string> | string[] | undefined,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  if (!envSpec || Array.isArray(envSpec)) {
    return out;
  }
  for (const [key, raw] of Object.entries(envSpec)) {
    const match = /^\$\{(.+)\}$/.exec(raw);
    out[key] = match ? base[match[1]] : raw;
  }
  return out;
}
