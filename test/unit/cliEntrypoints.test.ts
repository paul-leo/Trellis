/**
 * trellis-doctor-cli-version-split: PATH scan for diverging `trellis`
 * entrypoints. Stub executables live in scratch dirs; the version is
 * injected, so nothing here depends on the developer's real PATH.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { detectCliVersionSplit, findCliEntrypoints, type CliEntrypoint } from "../../src/lib/cliEntrypoints.js";
import { runDoctor } from "../../src/commands/doctor.js";
import { scratchHome, seedCanonical } from "../helpers/home.js";

function binDir(label: string, opts: { executable?: boolean } = {}): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), `trellis-bin-${label}-`));
  const file = join(dir, "trellis");
  writeFileSync(file, `#!/bin/sh\necho ${label}\n`);
  chmodSync(file, opts.executable === false ? 0o644 : 0o755);
  return { dir, file };
}

/** The injected executor reads the version from the stub's own body. */
const labelVersion = (path: string): string | undefined => {
  const m = /echo (\S+)/.exec(readFileSync(path, "utf-8"));
  return m ? m[1] : undefined;
};

const e = (path: string, version: string): CliEntrypoint => ({ path, version });

test("findCliEntrypoints: returns entries in PATH order", () => {
  const a = binDir("0.12.0");
  const b = binDir("0.16.0");
  const found = findCliEntrypoints({ pathEnv: [a.dir, b.dir].join(delimiter), execVersion: labelVersion });
  assert.deepEqual(found, [e(a.file, "0.12.0"), e(b.file, "0.16.0")]);
});

test("findCliEntrypoints: two PATH entries resolving to one real file are one entry", () => {
  const a = binDir("0.16.0");
  const linkDir = mkdtempSync(join(tmpdir(), "trellis-bin-link-"));
  symlinkSync(a.file, join(linkDir, "trellis"));
  const found = findCliEntrypoints({ pathEnv: [a.dir, linkDir].join(delimiter), execVersion: labelVersion });
  assert.equal(found.length, 1);
  assert.equal(found[0].path, a.file);
});

test("findCliEntrypoints: skips non-executable files, missing dirs and an entry that reports no version", () => {
  const ok = binDir("0.16.0");
  const noexec = binDir("0.12.0", { executable: false });
  const broken = binDir("x");
  const missing = join(tmpdir(), "trellis-bin-does-not-exist");
  mkdirSync(join(tmpdir(), "trellis-bin-empty-dir"), { recursive: true });
  const found = findCliEntrypoints({
    pathEnv: [noexec.dir, missing, broken.dir, ok.dir, ""].join(delimiter),
    execVersion: (p) => (p === broken.file ? undefined : labelVersion(p)),
  });
  assert.deepEqual(found, [e(ok.file, "0.16.0")]);
});

test("detectCliVersionSplit: stale entry shadows a newer one → message names both and marks the winner", () => {
  const msg = detectCliVersionSplit([e("/a/trellis", "0.12.0"), e("/b/trellis", "0.16.0")]);
  assert.ok(msg);
  assert.match(msg, /\/a\/trellis[^\n]*0\.12\.0/);
  assert.match(msg, /\/b\/trellis[^\n]*0\.16\.0/);
  assert.match(msg, /▶ runs\s+\/a\/trellis/);
  assert.match(msg, /does not modify/);
});

test("detectCliVersionSplit: no finding for zero, one, or all-equal entries", () => {
  assert.equal(detectCliVersionSplit([]), undefined);
  assert.equal(detectCliVersionSplit([e("/a", "0.16.0")]), undefined);
  assert.equal(detectCliVersionSplit([e("/a", "0.16.0"), e("/b", "0.16.0"), e("/c", "0.16.0")]), undefined);
});

async function doctorExit(pathEnv: string): Promise<{ exitCode: number; out: string }> {
  const home = scratchHome("cli-split");
  seedCanonical(home, { managed: [], instructions: "# g\n" });
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    const { exitCode } = await runDoctor({ json: true, homeDir: home, workspaceDir: null, pathEnv, execVersion: labelVersion });
    return { exitCode, out: lines.join("\n") };
  } finally {
    console.log = orig;
  }
}

test("runDoctor: diverging entrypoints → finding in --json and exit 1", async () => {
  const a = binDir("0.12.0");
  const b = binDir("0.16.0");
  const { exitCode, out } = await doctorExit([a.dir, b.dir].join(delimiter));
  assert.equal(exitCode, 1);
  const report = JSON.parse(out) as { findings: { kind: string; message: string }[] };
  const f = report.findings.find((x) => x.kind === "cli-version-split");
  assert.ok(f, "cli-version-split finding present");
  assert.ok(f.message.includes(a.file) && f.message.includes(b.file));
});

test("runDoctor: identical entrypoint versions → no cli-version-split finding", async () => {
  const a = binDir("0.16.0");
  const b = binDir("0.16.0");
  const { out } = await doctorExit([a.dir, b.dir].join(delimiter));
  const report = JSON.parse(out) as { findings: { kind: string }[] };
  assert.equal(report.findings.some((x) => x.kind === "cli-version-split"), false);
});
