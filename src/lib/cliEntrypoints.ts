/**
 * Locates every `trellis` executable on PATH and compares their versions
 * (trellis-doctor-cli-version-split). Read-only: it never edits, removes
 * or upgrades an entrypoint — a wrapper script may be deliberately
 * maintained by the user, so Trellis only reports.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface CliEntrypoint {
  path: string;
  version: string;
}

export type VersionExecutor = (path: string) => string | undefined;

const VERSION_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

/** Runs `<path> --version` via argv (no shell). `undefined` on any
 * failure or unrecognizable output, so a broken entry is skipped rather
 * than reported as a split. */
export const defaultExecVersion: VersionExecutor = (path) => {
  try {
    const out = execFileSync(path, ["--version"], { encoding: "utf-8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    return VERSION_RE.exec(out)?.[0];
  } catch {
    return undefined;
  }
};

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findCliEntrypoints(opts: { pathEnv?: string; execVersion?: VersionExecutor; name?: string } = {}): CliEntrypoint[] {
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const execVersion = opts.execVersion ?? defaultExecVersion;
  const name = opts.name ?? "trellis";
  const seenDirs = new Set<string>();
  const seenReal = new Set<string>();
  const entries: CliEntrypoint[] = [];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    const candidate = join(dir, name);
    if (!isExecutableFile(candidate)) continue;
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      continue;
    }
    if (seenReal.has(real)) continue;
    seenReal.add(real);
    // Spawn the PATH-visible path, not the resolved target: a shim's
    // behavior depends on the name it is invoked by.
    const version = execVersion(candidate);
    if (version) entries.push({ path: candidate, version });
  }
  return entries;
}

/** A finding message when two or more entries disagree; `undefined`
 * otherwise. The first entry is the one a bare `trellis` runs. */
export function detectCliVersionSplit(entries: readonly CliEntrypoint[]): string | undefined {
  if (entries.length < 2) return undefined;
  if (new Set(entries.map((e) => e.version)).size < 2) return undefined;
  const lines = entries.map((e, i) => `  ${i === 0 ? "▶ runs" : "  also"}  ${e.path}  ${e.version}`);
  return [
    `${entries.length} \`trellis\` entrypoints on PATH report different versions — a bare \`trellis\` runs ${entries[0].path} (${entries[0].version}), so upgrading another copy has no effect:`,
    ...lines,
    "Reconcile them (upgrade or remove the stale one, or reorder PATH) — Trellis does not modify entrypoints.",
  ].join("\n");
}
