/**
 * A deterministic digest for a directory tree.  Paths, empty directories,
 * file bytes, and link targets all contribute to the digest so it can be
 * used for provenance and for detecting edits before a remote update.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function addPart(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  hash.update(String(Buffer.byteLength(value)));
  hash.update(":");
  hash.update(value);
  hash.update("\0");
}

/**
 * Hashes a tree without following symbolic links.  A caller that needs a
 * stricter source policy can reject links separately; keeping their target in
 * this digest means a locally added link is still detected as drift.
 */
export function directoryDigest(dir: string): string {
  const hash = createHash("sha256");

  const walk = (current: string): void => {
    const rel = portablePath(relative(dir, current)) || ".";
    const stat = lstatSync(current);
    if (stat.isDirectory()) {
      addPart(hash, "directory");
      addPart(hash, rel);
      for (const name of readdirSync(current).sort((a, b) => a.localeCompare(b))) {
        walk(join(current, name));
      }
      return;
    }
    if (stat.isFile()) {
      addPart(hash, "file");
      addPart(hash, rel);
      addPart(hash, readFileSync(current));
      return;
    }
    if (stat.isSymbolicLink()) {
      addPart(hash, "symlink");
      addPart(hash, rel);
      addPart(hash, readlinkSync(current));
      return;
    }
    throw new Error(`Cannot digest unsupported filesystem entry: ${current}`);
  };

  walk(dir);
  return `sha256:${hash.digest("hex")}`;
}
