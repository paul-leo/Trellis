/**
 * Shared create/repair/remove/refuse decision logic every adapter needs
 * for both skills and the instructions file (openspec/changes/
 * trellis-sync-p1/specs/skill-instructions-sync/spec.md) — built once,
 * reused by every adapter rather than reimplemented per agent.
 */

import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { isSymlinkTo } from "../lib/fsIdentity.js";
import { currentLinkTarget, type BackupSession } from "../lib/backup.js";
import type { AdapterPlanItem } from "../core/adapter.js";

export interface DesiredSymlink {
  /** Basename this entry should have under `rootDir`. */
  name: string;
  /** Absolute path the symlink should point at (inside `canonicalRoot`). */
  target: string;
}

/**
 * A narrowly-scoped escape hatch for artifacts that Trellis can identify
 * across installation roots. The default ownership rule remains path-based;
 * callers must opt in explicitly for a particular artifact kind.
 */
export type ExistingSymlinkAdoption = (existingTarget: string, desiredTarget: string) => boolean;

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
  kind: "skill" | "instructions" | "extension";
  adoptExistingSymlink?: ExistingSymlinkAdoption;
}): AdapterPlanItem[] {
  const { rootDir, desired, kind, adoptExistingSymlink } = opts;
  const items: AdapterPlanItem[] = [];
  const desiredNames = new Set(desired.map((d) => d.name));
  const canonicalRootResolved = resolve(opts.canonicalRoot);

  for (const { name, target } of desired) {
    const path = join(rootDir, name);

    if (isSymlinkTo(path, target)) {
      continue; // already correct — no-op
    }

    // lstat sees dangling links too; existsSync would treat them as absent
    // and bypass the foreign-link protection below.
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing) {
      const isSymlink = existing.isSymbolicLink();
      const rawExistingTarget = isSymlink ? readlinkSync(path) : undefined;
      const resolvedExistingTarget = rawExistingTarget === undefined
        ? undefined
        : resolve(dirname(path), rawExistingTarget);
      // A symlink whose stored target resolves outside canonicalRoot is
      // owned by something else (e.g. a user's own dotfile-management
      // setup) — repairing it as if it were a stale Trellis entry would
      // silently steal that ownership. Raw readlink, not realpath: a
      // symlink Trellis itself left pointing at a since-removed canonical
      // entry is broken by construction and must still be treated as
      // ours to repair, not thrown out to a conflict by a realpath error.
      const isForeign = resolvedExistingTarget !== undefined
        && !isUnderRoot(resolvedExistingTarget, canonicalRootResolved)
        && adoptExistingSymlink?.(resolvedExistingTarget, target) !== true;
      if (!isSymlink || isForeign) {
        items.push({
          action: "conflict",
          kind,
          target: path,
          description: isForeign
            ? `${path} exists as a symlink to ${rawExistingTarget}, not owned by Trellis — left untouched`
            : `${path} exists and is not a Trellis-managed symlink — left untouched`,
          remediation: isForeign
            ? `remove the existing symlink at ${path} if you want Trellis to manage it, then re-run sync — otherwise leave it, Trellis will not touch it`
            : `back up ${path}'s real content if you need it, remove the file, then re-run sync — Trellis will not overwrite or merge into an existing real file`,
        });
        continue;
      }
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

/** Executes a `planSymlinks` result through the run's backup session
 * (trellis-backup-rollback) — every create/repair/remove is recorded
 * before it happens; `backup` performs the actual filesystem write, this
 * function never calls `fs/promises` itself. "conflict" is report-only —
 * see src/core/adapter.ts's `apply()` doc for why this never throws. */
export async function applySymlinkPlan(plan: AdapterPlanItem[], backup: BackupSession): Promise<void> {
  for (const item of plan) {
    if (item.action === "conflict") continue;
    if (item.action === "remove") {
      const oldTarget = await currentLinkTarget(item.target);
      if (oldTarget === undefined) continue; // already gone — no-op, nothing to record
      await backup.removeSymlink(item.target, oldTarget);
      continue;
    }
    // "create" also covers repair — rootDir may not exist yet (first
    // sync ever for this agent).
    if (!item.linkTarget) continue;
    await mkdir(resolve(item.target, ".."), { recursive: true });
    const oldTarget = await currentLinkTarget(item.target);
    if (oldTarget === undefined) {
      await backup.createSymlink(item.target, item.linkTarget);
    } else {
      await backup.repairSymlink(item.target, oldTarget, item.linkTarget);
    }
  }
}
