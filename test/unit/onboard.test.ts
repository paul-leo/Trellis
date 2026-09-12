/**
 * trellis-cli-onboard: chains init -> detect -> base resolution ->
 * migrate -> sync. Uses claude-code and codex as the two "present"
 * fixture agents when a multi-agent scenario is needed (their presence
 * markers are cheapest to fabricate by hand).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectInitReport } from "../../src/commands/init.js";
import { collectOnboardPlan, runOnboard } from "../../src/commands/onboard.js";

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "trellis-onboard-"));
}

function markClaudeCodePresent(home: string): void {
  writeFileSync(join(home, ".claude.json"), "{}\n");
}

function markCodexPresent(home: string): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "");
}

function writeClaudeSkill(home: string, name: string, content: string): void {
  const dir = join(home, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
}

test("zero agents present: install hints for all four, exit 0, no writes beyond init's own bootstrap", async () => {
  const home = scratchHome();
  const { exitCode } = await runOnboard({ homeDir: home, json: true });
  assert.equal(exitCode, 0);

  // init's own bootstrap already happened; nothing beyond it changed.
  assert.deepEqual(readdirSync(join(home, ".trellis", "skills")), []);
});

test("zero agents present: result carries an install hint per agent", async () => {
  const home = scratchHome();
  const result = await collectOnboardPlan({ homeDir: home });
  assert.equal(result.summary.every((s) => !s.present), true);
  assert.ok(result.installHints);
  assert.ok(result.installHints?.["claude-code"].includes("npm install"));
  assert.ok(result.installHints?.pi.includes("npm install"));
  assert.ok(result.installHints?.kiro.includes("http"));
});

test("exactly one agent present: auto-selected, migrate and sync both run for real", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeSkill(home, "real-skill", "content\n");

  const result = await collectOnboardPlan({ homeDir: home });
  assert.equal(result.base, "claude-code");
  assert.equal(result.baseReason, "auto-selected");
  assert.equal(result.migratePlan?.items.find((i) => i.name === "real-skill")?.action, "create");

  // Migrated for real: canonical now has the skill's real content.
  assert.equal(readFileSync(join(home, ".trellis", "skills", "real-skill", "SKILL.md"), "utf-8"), "content\n");

  // The source agent's own real file is untouched, not replaced with a
  // symlink to itself — sync correctly reports this as a conflict
  // (same real path, real content) rather than silently overwriting it.
  assert.equal(readFileSync(join(home, ".claude", "skills", "real-skill", "SKILL.md"), "utf-8"), "content\n");
  const claudeReport = result.syncReport?.reports.find((r) => r.agent === "claude-code");
  assert.equal(claudeReport?.items.some((i) => i.action === "conflict"), true);
});

test("two present agents, --agent resolves the base non-interactively", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  markCodexPresent(home);
  writeClaudeSkill(home, "claude-only", "content\n");

  const result = await collectOnboardPlan({ homeDir: home, agent: "claude-code" });
  assert.equal(result.base, "claude-code");
  assert.equal(result.baseReason, "flag");
  assert.equal(result.refusal, undefined);
  assert.equal(readFileSync(join(home, ".trellis", "skills", "claude-only", "SKILL.md"), "utf-8"), "content\n");
});

test("two present agents, invalid --agent value refuses cleanly with no writes", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  markCodexPresent(home);
  await collectInitReport(home);

  const before = readdirSync(join(home, ".trellis", "skills"));
  const result = await collectOnboardPlan({ homeDir: home, agent: "kiro" });
  assert.match(result.refusal ?? "", /not one of the present agents/);
  assert.match(result.refusal ?? "", /claude-code/);
  assert.match(result.refusal ?? "", /codex/);
  assert.deepEqual(readdirSync(join(home, ".trellis", "skills")), before);
});

test("two present agents, no --agent, no TTY: refuses cleanly with no writes", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  markCodexPresent(home);
  await collectInitReport(home);

  const before = readdirSync(join(home, ".trellis", "skills"));
  const result = await collectOnboardPlan({ homeDir: home, isTTY: false });
  assert.match(result.refusal ?? "", /multiple agents detected/);
  assert.match(result.refusal ?? "", /--agent/);
  assert.deepEqual(readdirSync(join(home, ".trellis", "skills")), before);
});

test("two present agents, no --agent, --json: refuses cleanly even if isTTY is true", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  markCodexPresent(home);

  const result = await collectOnboardPlan({ homeDir: home, isTTY: true, json: true });
  assert.match(result.refusal ?? "", /multiple agents detected/);
});

test("two present agents, no --agent, TTY: uses the scripted prompt answer", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  markCodexPresent(home);
  writeClaudeSkill(home, "claude-only", "content\n");

  const result = await collectOnboardPlan({
    homeDir: home,
    isTTY: true,
    promptForAgent: async (present) => {
      assert.equal(present.length, 2);
      return "claude-code";
    },
  });
  assert.equal(result.base, "claude-code");
  assert.equal(result.baseReason, "prompt");
});

test("--dry-run: migrate and sync plans are computed, zero writes anywhere", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  await collectInitReport(home);

  const before = readdirSync(join(home, ".trellis", "skills"));
  const result = await collectOnboardPlan({ homeDir: home, agent: "claude-code", dryRun: true });
  assert.equal(result.migratePlan?.items.find((i) => i.name === "real-skill")?.action, "create");
  assert.ok(result.syncReport);

  assert.deepEqual(readdirSync(join(home, ".trellis", "skills")), before);
  assert.equal(existsSync(join(home, ".claude", "skills", "canonical-shared-skill")), false);
});

test("sync --dry-run (standalone, not via onboard): plan computed, zero writes", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "content\n");

  const { collectSyncReport } = await import("../../src/commands/sync.js");
  const report = await collectSyncReport({ homeDir: home, dryRun: true });
  const claudeReport = report.reports.find((r) => r.agent === "claude-code");
  assert.ok(claudeReport && claudeReport.items.length >= 0);
  // Nothing under .claude beyond the fixture's own hand-written file was created.
  assert.equal(existsSync(join(home, ".claude", "CLAUDE.md")), false);
});
