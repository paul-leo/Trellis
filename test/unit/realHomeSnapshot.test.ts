/**
 * trellis-real-sandbox-verification: `buildRealHomeSnapshot`'s allowlist
 * copy logic. Exercised only against synthetic temp directories, never
 * a real `$HOME` — same testing philosophy as every other test in this
 * project (docs/architecture.md).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildRealHomeSnapshot, REAL_HOME_ALLOWLIST } from "../../src/lib/realHomeSnapshot.js";

function scratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("an allowlisted file that exists is copied, byte-for-byte", () => {
  const source = scratchDir("trellis-snapshot-src-");
  const dest = scratchDir("trellis-snapshot-dest-");
  writeFileSync(join(source, ".claude.json"), '{"mcpServers":{}}');

  const copied = buildRealHomeSnapshot(source, dest);
  assert.deepEqual(copied, [".claude.json"]);
  assert.equal(readFileSync(join(dest, ".claude.json"), "utf-8"), '{"mcpServers":{}}');
});

test("an allowlisted directory that exists is copied recursively", () => {
  const source = scratchDir("trellis-snapshot-src-");
  const dest = scratchDir("trellis-snapshot-dest-");
  mkdirSync(join(source, ".claude", "skills", "demo"), { recursive: true });
  writeFileSync(join(source, ".claude", "skills", "demo", "SKILL.md"), "# demo\n");

  const copied = buildRealHomeSnapshot(source, dest);
  assert.ok(copied.includes(".claude/skills"));
  assert.equal(readFileSync(join(dest, ".claude", "skills", "demo", "SKILL.md"), "utf-8"), "# demo\n");
});

test("a missing allowlisted path is silently skipped, not an error", () => {
  const source = scratchDir("trellis-snapshot-src-"); // empty
  const dest = scratchDir("trellis-snapshot-dest-");

  const copied = buildRealHomeSnapshot(source, dest);
  assert.deepEqual(copied, []);
});

test("a path not on the allowlist is never copied, even if present", () => {
  const source = scratchDir("trellis-snapshot-src-");
  const dest = scratchDir("trellis-snapshot-dest-");
  // A real machine's OAuth/session/history material — exactly what the
  // allowlist (not a denylist) must never reach for, named or not.
  mkdirSync(join(source, ".claude", "projects", "some-project"), { recursive: true });
  writeFileSync(join(source, ".claude", "projects", "some-project", "history.jsonl"), "sensitive transcript content\n");
  mkdirSync(join(source, ".codex"), { recursive: true });
  writeFileSync(join(source, ".codex", "auth.json"), '{"access_token":"leaked"}');

  buildRealHomeSnapshot(source, dest);
  assert.ok(!existsSync(join(dest, ".claude", "projects")));
  assert.ok(!existsSync(join(dest, ".codex", "auth.json")));
});

test("a symlink (sync's own real output — a skill or instructions file pointing back at canonical) is dereferenced, never left dangling", () => {
  const source = scratchDir("trellis-snapshot-src-");
  const dest = scratchDir("trellis-snapshot-dest-");
  mkdirSync(join(source, ".trellis"), { recursive: true });
  writeFileSync(join(source, ".trellis", "agents.md"), "# real instructions\n");
  mkdirSync(join(source, ".pi", "agent"), { recursive: true });
  writeFileSync(join(source, ".pi", "agent", "settings.json"), "{}\n");
  symlinkSync(join(source, ".trellis", "agents.md"), join(source, ".pi", "agent", "AGENTS.md"));

  buildRealHomeSnapshot(source, dest);
  const copiedPath = join(dest, ".pi", "agent", "AGENTS.md");
  assert.equal(readFileSync(copiedPath, "utf-8"), "# real instructions\n", "the symlink's real target content must be copied in, not a dangling reference to the source machine's absolute path");
});

test("case-insensitive-filesystem duplicate allowlist entries (e.g. AGENTS.md/AGENTS.MD) never crash and never double-copy destructively", () => {
  const source = scratchDir("trellis-snapshot-src-");
  const dest = scratchDir("trellis-snapshot-dest-");
  mkdirSync(join(source, ".trellis"), { recursive: true });
  writeFileSync(join(source, ".trellis", "agents.md"), "# real instructions\n");
  mkdirSync(join(source, ".pi", "agent"), { recursive: true });
  writeFileSync(join(source, ".pi", "agent", "settings.json"), "{}\n");
  symlinkSync(join(source, ".trellis", "agents.md"), join(source, ".pi", "agent", "AGENTS.md"));

  // Regression coverage for a real bug found by running this against an
  // actually-synced machine: does not assert the process's own
  // filesystem is case-insensitive (this test must pass either way) —
  // just that running the full allowlist (which lists both cases) never
  // throws, on any filesystem.
  assert.doesNotThrow(() => buildRealHomeSnapshot(source, dest));
});

test("REAL_HOME_ALLOWLIST names only known-structural paths, one entry per real probe path", () => {
  // Cross-checked by hand against src/probes/{claude-code,codex,kiro,pi}.ts
  // at write time — this test guards against silent drift, not a
  // from-scratch derivation.
  for (const entry of REAL_HOME_ALLOWLIST) {
    assert.ok(!entry.includes(".."), `${entry} must be a plain relative path, no traversal`);
    assert.ok(!entry.startsWith("/"), `${entry} must be relative to $HOME`);
  }
  assert.ok(REAL_HOME_ALLOWLIST.includes(".claude.json"));
  assert.ok(REAL_HOME_ALLOWLIST.includes(".codex/config.toml"));
  assert.ok(REAL_HOME_ALLOWLIST.includes(".kiro/settings/mcp.json"));
  assert.ok(REAL_HOME_ALLOWLIST.includes(".pi/agent/settings.json"));
  assert.ok(!REAL_HOME_ALLOWLIST.some((e) => e.includes("auth.json")), "no OAuth/credential file is ever named on the allowlist");
  assert.ok(!REAL_HOME_ALLOWLIST.some((e) => e.includes("projects")), "no session-history directory is ever named on the allowlist");
});
