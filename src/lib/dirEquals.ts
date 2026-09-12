/**
 * Byte-for-byte directory content comparison (trellis-cli-migrate design.md
 * D2) — "already migrated, safe to skip" vs. "a real conflict" is decided
 * by this, not by name/mtime/hash-shortcut. Same set of relative file
 * paths, same bytes per file; anything else is unequal.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function listFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        results.push(relative(dir, full));
      }
    }
  };
  walk(dir);
  return results.sort();
}

export function dirContentsEqual(a: string, b: string): boolean {
  const filesA = listFilesRecursive(a);
  const filesB = listFilesRecursive(b);
  if (filesA.length !== filesB.length) return false;
  for (let i = 0; i < filesA.length; i++) {
    if (filesA[i] !== filesB[i]) return false;
  }
  for (const rel of filesA) {
    if (!readFileSync(join(a, rel)).equals(readFileSync(join(b, rel)))) return false;
  }
  return true;
}
