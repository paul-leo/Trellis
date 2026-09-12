/**
 * Shared create/repair/remove/refuse decision logic every adapter needs
 * for both skills and the instructions file (openspec/changes/
 * trellis-sync-p1/specs/skill-instructions-sync/spec.md) — built once,
 * reused by every adapter rather than reimplemented per agent.
 */

import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { isSymlinkTo } from "../lib/fsIdentity.js";
import type { AdapterPlanItem } from "../core/adapter.js";

export interface DesiredSymlink {
  /** Basename this entry should have under `rootDir`. */
  name: string;
  /** Absolute path the symlink should point at (inside `canonicalRoot`). */
  target: string;
}

function isUnderRoot(path: string, root: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  if (normalizedPath === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return normalizedPath.startsWith(prefix);
}

/**
 * `rootDir` is the directory entries are named directly under (e.g.
 * `~/.claude/skills`, or the instructions file's own parent directory when
 * `desired` has exactly one entry). `canonicalRoot` is what proves
 * ownership for removal — an existing symlink's stored (readlink) target
 * must resolve inside it before this function will ever plan removing it.
 * Deliberately not realpath-based here (unlike `isSymlinkTo` above, used
 * for create/repair): a symlink whose canonical target was just deleted
 * is broken by construction, and realpath throws on those — exactly the
 * case this removal path exists to catch.
 */
export function planSymlinks(opts: {
  rootDir: string;
  desired: DesiredSymlink[];
  canonicalRoot: string;
  kind: "skill" | "instructions";
}): AdapterPlanItem[] {
  const { rootDir, desired, kind } = opts;
  const items: AdapterPlanItem[] = [];
  const desiredNames = new Set(desired.map((d) => d.name));
  const canonicalRootResolved = resolve(opts.canonicalRoot);

  for (const { name, target } of desired) {
    const path = join(rootDir, name);

    if (isSymlinkTo(path, target)) {
      continue; // already correct — no-op
    }

    if (existsSync(path) && !lstatSync(path).isSymbolicLink()) {
      items.push({
        action: "conflict",
        kind,
        target: path,
        description: `${path} exists and is not a Trellis-managed symlink — left untouched`,
      });
      continue;
    }

    items.push({
      action: "create",
      kind,
      target: path,
      linkTarget: target,
      description: `symlink ${path} -> ${target}`,
    });
  }

  let existingEntries: string[] = [];
  try {
    existingEntries = readdirSync(rootDir);
  } catch {
    existingEntries = [];
  }

  for (const name of existingEntries) {
    if (desiredNames.has(name)) continue;
    const path = join(rootDir, name);

    let isSymlink: boolean;
    try {
      isSymlink = lstatSync(path).isSymbolicLink();
    } catch {
      continue;
    }
    if (!isSymlink) continue; // real content, not Trellis's — never touched, never even reported

    // Ownership proof uses the symlink's raw stored target (readlink), not
    // realpath: the whole point of this branch is deleted-canonical-entry
    // symlinks, which are BROKEN by construction (their target no longer
    // exists) — realpath throws on those, which would silently skip
    // exactly the case "remove a deleted skill's stale symlink" exists to
    // catch. Trellis always writes an absolute path as the link target
    // (see applySymlinkPlan), so comparing the raw stored string against
    // canonicalRoot needs no filesystem resolution on either side.
    let linkTarget: string;
    try {
      linkTarget = readlinkSync(path);
    } catch {
      continue;
    }
    if (!isUnderRoot(linkTarget, canonicalRootResolved)) continue; // points somewhere else — not ours

    items.push({
      action: "remove",
      kind,
      target: path,
      description: `remove stale symlink ${path} (canonical entry gone or scoped away)`,
    });
  }

  return items;
}

/** Executes a `planSymlinks` result. "conflict" is report-only — see
 * src/core/adapter.ts's `apply()` doc for why this never throws. */
export async function applySymlinkPlan(plan: AdapterPlanItem[]): Promise<void> {
  for (const item of plan) {
    if (item.action === "conflict") continue;
    if (item.action === "remove") {
      await rm(item.target, { force: true });
      continue;
    }
    // "create": rootDir may not exist yet (first sync ever for this agent)
    if (!item.linkTarget) continue;
    await mkdir(resolve(item.target, ".."), { recursive: true });
    await rm(item.target, { force: true }); // clear a wrong-target symlink before repointing
    await symlink(item.linkTarget, item.target);
  }
}
