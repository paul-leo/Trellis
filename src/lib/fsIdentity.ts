/**
 * Filesystem identity by realpath, never by string path or content hash.
 * See design.md D3 (openspec/changes/trellis-doctor-p0): two physical
 * copies of identical content are NOT the same thing to an agent's own
 * discovery logic (Codex, pi both dedup this way independently) — only a
 * symlink to the same target is.
 */

import { lstatSync, realpathSync } from "node:fs";

export function isSymlinkTo(path: string, target: string): boolean {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return false;
  }
  if (!stat.isSymbolicLink()) {
    return false;
  }
  try {
    return realpathSync(path) === realpathSync(target);
  } catch {
    return false;
  }
}

/**
 * Groups paths by realpath. Two ordinary directories with byte-identical
 * content but no symlink between them land in separate buckets — that's
 * the point, not a bug (see D3). A path that can't be resolved (broken
 * symlink, missing) is bucketed on its own literal path instead, so it's
 * never silently dropped from the result.
 */
export function realpathDedupe(paths: string[]): Map<string, string[]> {
  const buckets = new Map<string, string[]>();
  for (const path of paths) {
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      real = path;
    }
    const bucket = buckets.get(real);
    if (bucket) {
      bucket.push(path);
    } else {
      buckets.set(real, [path]);
    }
  }
  return buckets;
}
