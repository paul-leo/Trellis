import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectInitReport } from "../../src/commands/init.js";
import { applyMigratePlan, collectMigratePlan } from "../../src/commands/migrate.js";
import { discoverNativeMemory, renderNativeMemory } from "../../src/lib/nativeMemory.js";

function home(): string {
  return mkdtempSync(join(tmpdir(), "trellis-native-memory-"));
}

test("Claude Code adapter imports only the exact current-workspace Markdown memory directory", () => {
  const value = home();
  const workspace = "/workspace/project";
  const root = join(value, ".claude", "projects", "-workspace-project", "memory");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "MEMORY.md"), "# durable note\n");
  mkdirSync(join(value, ".claude", "projects", "-workspace-other", "memory"), { recursive: true });
  writeFileSync(join(value, ".claude", "projects", "-workspace-other", "memory", "other.md"), "must not import\n");

  const result = discoverNativeMemory("claude-code", value, workspace);
  assert.equal(result.status, "supported");
  assert.deepEqual(result.candidates.map((candidate) => candidate.displayName), ["MEMORY"]);
  assert.equal(result.candidates[0].targetName, "claude-workspace-project-memory");
  assert.match(renderNativeMemory(result.candidates[0]), /Trellis import: claude-code/);
  assert.match(renderNativeMemory(result.candidates[0]), /durable note/);
});

test("Kimi Code and pi native session stores are explicitly unsupported", () => {
  const value = home();
  mkdirSync(join(value, ".kimi-code", "sessions"), { recursive: true });
  writeFileSync(join(value, ".kimi-code", "sessions", "session.jsonl"), "secret conversation\n");
  mkdirSync(join(value, ".pi", "agent", "sessions"), { recursive: true });
  writeFileSync(join(value, ".pi", "agent", "sessions", "session.jsonl"), "secret conversation\n");

  for (const agent of ["kimi-code", "pi"] as const) {
    const result = discoverNativeMemory(agent, value, "/workspace/project");
    assert.equal(result.status, "unsupported");
    assert.equal(result.candidates.length, 0);
    assert.match(result.detail, /unsupported/);
    assert.match(result.detail, /credential/);
  }
});

test("memory migration plan imports canonical Markdown idempotently", async () => {
  const value = home();
  const workspace = "/workspace/project";
  await collectInitReport(value);
  writeFileSync(join(value, ".claude.json"), "{}\n");
  const root = join(value, ".claude", "projects", "-workspace-project", "memory");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "MEMORY.md"), "# durable note\n");

  const plan = await collectMigratePlan("claude-code", value, ["memory"], workspace);
  assert.equal(plan.memoryDiscovery?.status, "supported");
  assert.equal(plan.items[0].kind, "memory");
  assert.equal(plan.items[0].action, "create");
  applyMigratePlan(plan, value);
  const second = await collectMigratePlan("claude-code", value, ["memory"], workspace);
  assert.equal(second.items[0].action, "already-migrated");
});

test("Codex adapter uses CODEX_HOME and ignores sessions, indexes, and non-Markdown state", () => {
  const value = home();
  const codexHome = join(value, "codex-state");
  mkdirSync(join(codexHome, "memories"), { recursive: true });
  writeFileSync(join(codexHome, "memories", "persistent.md"), "# Codex persistent note\n");
  writeFileSync(join(codexHome, "session_index.jsonl"), "must not inspect\n");
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  writeFileSync(join(codexHome, "sessions", "session.md"), "must not import\n");

  const result = discoverNativeMemory("codex", value, "/workspace/project", { CODEX_HOME: codexHome });
  assert.equal(result.status, "supported");
  assert.deepEqual(result.candidates.map((candidate) => candidate.displayName), ["persistent"]);
  assert.equal(result.candidates[0].targetName, "codex-persistent");
});

test("Codex adapter reports empty when only session state exists", () => {
  const value = home();
  const codexHome = join(value, ".codex");
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  writeFileSync(join(codexHome, "session_index.jsonl"), "session state\n");
  writeFileSync(join(codexHome, "sessions", "transcript.jsonl"), "conversation\n");
  const result = discoverNativeMemory("codex", value, "/workspace/project");
  assert.equal(result.status, "empty");
  assert.equal(result.candidates.length, 0);
});
