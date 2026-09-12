/**
 * trellis-sdk-p5: the public SDK barrel. Two kinds of check here —
 * (1) a source-level test that the barrel actually works and doesn't
 * leak adapter/command internals (fast, runs with everything else), and
 * (2) a real package-resolution check via `test/sdk-consumer` (slow,
 * spawns `npm run build` + a real Node import through package "exports"
 * resolution — see that directory's own README-style comment at the top
 * of its script for why a source-relative import can't catch what this
 * catches).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as sdk from "../../src/sdk.js";

const SDK_SOURCE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "sdk.ts");

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-sdk-"));
  mkdirSync(join(home, ".trellis", "skills", "sample"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(join(home, ".trellis", "skills", "sample", "SKILL.md"), "---\nname: sample\ndescription: fixture\n---\n");
  return home;
}

test("sdk: loadCanonicalSource is callable and returns the expected shape", () => {
  const home = scratchHome();
  const canonical = sdk.loadCanonicalSource(home);
  assert.equal(canonical.skills.length, 1);
  assert.equal(canonical.skills[0].name, "sample");
  assert.deepEqual(canonical.mcp, { servers: {}, knownHostInjected: [] });
  assert.deepEqual(canonical.secretsPolicy, { allowedVars: [], rejectPatterns: [] });
});

test("sdk: ALL_AGENTS and resolveScope are exported and behave correctly", () => {
  assert.deepEqual([...sdk.ALL_AGENTS], ["claude-code", "codex", "kiro", "pi"]);
  assert.deepEqual(sdk.resolveScope(undefined), sdk.ALL_AGENTS);
  assert.deepEqual(sdk.resolveScope(["claude-code"]), ["claude-code"]);
});

test("sdk: the barrel never re-exports adapter or command internals (design.md D1)", () => {
  const importLines = readFileSync(SDK_SOURCE_PATH, "utf-8")
    .split("\n")
    .filter((line) => /^(import|export)\b.*\bfrom\b/.test(line));
  assert.ok(importLines.length > 0, "sanity check: the barrel must have at least one import/export-from line");
  assert.ok(!importLines.some((line) => line.includes("adapters/")), "must not import from src/adapters/*");
  assert.ok(!importLines.some((line) => line.includes("commands/")), "must not import from src/commands/*");

  const exportedNames = Object.keys(sdk);
  const forbidden = ["planSymlinks", "resolveMcpPlan", "applyJsonMcp", "upsertSection", "ClaudeCodeAdapter", "CodexAdapter", "KiroAdapter", "PiAdapter"];
  for (const name of forbidden) {
    assert.ok(!exportedNames.includes(name), `${name} must not be part of the public SDK surface`);
  }
});
