/**
 * trellis-cli-migrate: imports an existing agent's real skills/
 * instructions into canonical source. Uses claude-code as the exercised
 * agent throughout (its probe's directory layout is the simplest of the
 * four) — the plan/apply logic itself is agent-agnostic.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AGENTS_MD_TEMPLATE, collectInitReport } from "../../src/commands/init.js";
import { applyMigratePlan, collectMigratePlan, runMigrate } from "../../src/commands/migrate.js";

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "trellis-migrate-"));
}

/** claude-code's probe treats `~/.claude.json` as the presence marker. */
function markClaudeCodePresent(home: string): void {
  writeFileSync(join(home, ".claude.json"), "{}\n");
}

function writeClaudeSkill(home: string, name: string, content: string): void {
  const dir = join(home, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
}

function writeClaudeInstructions(home: string, content: string): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "CLAUDE.md"), content);
}

test("a real, non-symlinked skill is copied into canonical source", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "# Real Skill\ncontent\n");

  const plan = await collectMigratePlan("claude-code", home);
  const item = plan.items.find((i) => i.kind === "skill" && i.name === "real-skill");
  assert.equal(item?.action, "create");

  applyMigratePlan(plan, home);
  assert.equal(readFileSync(join(home, ".trellis", "skills", "real-skill", "SKILL.md"), "utf-8"), "# Real Skill\ncontent\n");
});

test("a symlinked skill is skipped, not copied", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  const realSource = join(home, "shared-source-skill");
  mkdirSync(realSource, { recursive: true });
  writeFileSync(join(realSource, "SKILL.md"), "shared\n");
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  symlinkSync(realSource, join(home, ".claude", "skills", "shared-skill"));

  const plan = await collectMigratePlan("claude-code", home);
  const item = plan.items.find((i) => i.kind === "skill" && i.name === "shared-skill");
  assert.equal(item?.action, "skip-symlink");

  applyMigratePlan(plan, home);
  assert.equal(existsSync(join(home, ".trellis", "skills", "shared-skill")), false);
});

test("a case-broken skill (lowercase skill.md) is skipped, not copied", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  const dir = join(home, ".claude", "skills", "broken-case-skill");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skill.md"), "broken\n");

  const plan = await collectMigratePlan("claude-code", home);
  const item = plan.items.find((i) => i.kind === "skill" && i.name === "broken-case-skill");
  assert.equal(item?.action, "skip-case-broken");

  applyMigratePlan(plan, home);
  assert.equal(existsSync(join(home, ".trellis", "skills", "broken-case-skill")), false);
});

test("re-running migrate after success reports already-migrated and writes nothing", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  writeClaudeInstructions(home, "# Real instructions\n");

  const first = await collectMigratePlan("claude-code", home);
  applyMigratePlan(first, home);
  const mtimeAfterFirst = statSync(join(home, ".trellis", "skills", "real-skill", "SKILL.md")).mtimeMs;

  const second = await collectMigratePlan("claude-code", home);
  const skillItem = second.items.find((i) => i.kind === "skill" && i.name === "real-skill");
  const instructionsItem = second.items.find((i) => i.kind === "instructions");
  assert.equal(skillItem?.action, "already-migrated");
  assert.equal(instructionsItem?.action, "already-migrated");

  applyMigratePlan(second, home);
  assert.equal(statSync(join(home, ".trellis", "skills", "real-skill", "SKILL.md")).mtimeMs, mtimeAfterFirst);
});

test("a canonical skill with different content is a conflict, left untouched", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "source version\n");
  mkdirSync(join(home, ".trellis", "skills", "real-skill"), { recursive: true });
  writeFileSync(join(home, ".trellis", "skills", "real-skill", "SKILL.md"), "different canonical version\n");

  const plan = await collectMigratePlan("claude-code", home);
  const item = plan.items.find((i) => i.kind === "skill" && i.name === "real-skill");
  assert.equal(item?.action, "conflict");

  applyMigratePlan(plan, home);
  assert.equal(readFileSync(join(home, ".trellis", "skills", "real-skill", "SKILL.md"), "utf-8"), "different canonical version\n");
});

test("instructions: a placeholder agents.md is replaced with real content", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), AGENTS_MD_TEMPLATE);
  writeClaudeInstructions(home, "# My real preferences\nAlways be terse.\n");

  const plan = await collectMigratePlan("claude-code", home);
  const item = plan.items.find((i) => i.kind === "instructions");
  assert.equal(item?.action, "create");

  applyMigratePlan(plan, home);
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), "# My real preferences\nAlways be terse.\n");
});

test("instructions: real, pre-existing agents.md content is a conflict, not overwritten", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeFileSync(join(home, ".trellis", "agents.md"), "# Hand-authored, already real\n");
  writeClaudeInstructions(home, "# Claude Code's own instructions\n");

  const plan = await collectMigratePlan("claude-code", home);
  const item = plan.items.find((i) => i.kind === "instructions");
  assert.equal(item?.action, "conflict");

  applyMigratePlan(plan, home);
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), "# Hand-authored, already real\n");
});

test("a migrated skill is unscoped — no scope.yaml is created", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "content\n");

  const plan = await collectMigratePlan("claude-code", home);
  applyMigratePlan(plan, home);

  assert.equal(existsSync(join(home, ".trellis", "scope.yaml")), false);
});

test("--dry-run computes the plan without writing anything", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  writeClaudeInstructions(home, "# real\n");

  const before = readdirSync(join(home, ".trellis", "skills"));
  const { exitCode } = await runMigrate({ from: "claude-code", dryRun: true, homeDir: home, json: true });
  assert.equal(exitCode, 0);

  const after = readdirSync(join(home, ".trellis", "skills"));
  assert.deepEqual(before, after);
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), AGENTS_MD_TEMPLATE);
});

test("--from with an invalid agent id refuses cleanly", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  const { exitCode } = await runMigrate({ from: "not-a-real-agent", homeDir: home });
  assert.equal(exitCode, 1);
});

test("--from an agent that isn't present refuses cleanly, no writes", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  // No .claude/ directory at all in this scratch home — claude-code is not present.
  const { exitCode } = await runMigrate({ from: "claude-code", homeDir: home });
  assert.equal(exitCode, 1);
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), AGENTS_MD_TEMPLATE);
});

test("--only instructions excludes every skill from the plan, none read or written", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  writeClaudeInstructions(home, "# real\n");

  const plan = await collectMigratePlan("claude-code", home, ["instructions"]);
  assert.equal(plan.items.some((i) => i.kind === "skill"), false);
  assert.equal(plan.items.filter((i) => i.kind === "instructions").length, 1);

  applyMigratePlan(plan, home);
  assert.equal(existsSync(join(home, ".trellis", "skills", "real-skill")), false);
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), "# real\n");
});

test("--only skills excludes instructions from the plan, agents.md untouched", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  writeClaudeInstructions(home, "# real\n");

  const plan = await collectMigratePlan("claude-code", home, ["skill"]);
  assert.equal(plan.items.some((i) => i.kind === "instructions"), false);
  assert.equal(plan.items.filter((i) => i.kind === "skill").length, 1);

  applyMigratePlan(plan, home);
  assert.equal(readFileSync(join(home, ".trellis", "skills", "real-skill", "SKILL.md"), "utf-8"), "content\n");
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), AGENTS_MD_TEMPLATE);
});

test("runMigrate --only instructions excludes skills end to end", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  writeClaudeInstructions(home, "# real\n");

  const { exitCode } = await runMigrate({ from: "claude-code", only: "instructions", homeDir: home });
  assert.equal(exitCode, 0);
  assert.equal(existsSync(join(home, ".trellis", "skills", "real-skill")), false);
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), "# real\n");
});

test("omitting --only remains today's behavior: both kinds migrate", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  writeClaudeInstructions(home, "# real\n");

  const plan = await collectMigratePlan("claude-code", home);
  assert.equal(plan.items.some((i) => i.kind === "skill"), true);
  assert.equal(plan.items.some((i) => i.kind === "instructions"), true);
});

test("an invalid --only value refuses before probing the agent, no writes", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "content\n");

  const { exitCode } = await runMigrate({ from: "claude-code", only: "bogus", homeDir: home });
  assert.equal(exitCode, 1);
  assert.equal(existsSync(join(home, ".trellis", "skills", "real-skill")), false);
});

function writeClaudeMcpServer(home: string, name: string, entry: Record<string, unknown>): void {
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { [name]: entry } }));
}

test("mcp: a new MCP server is imported from claude-code into servers.yaml", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  writeClaudeMcpServer(home, "gitlab", { type: "stdio", command: "npx", args: ["-y", "@zereight/mcp-gitlab"], env: { GITLAB_PERSONAL_ACCESS_TOKEN: "${GITLAB_PERSONAL_ACCESS_TOKEN}" } });

  const plan = await collectMigratePlan("claude-code", home, ["mcp"]);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].action, "create");
  assert.equal(plan.items[0].name, "gitlab");

  applyMigratePlan(plan, home);
  const written = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  assert.match(written, /gitlab:/);
  assert.match(written, /command: npx/);
});

test("mcp: re-running migrate after a successful import is a no-op", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  writeClaudeMcpServer(home, "gitlab", { type: "stdio", command: "npx" });

  const first = await collectMigratePlan("claude-code", home, ["mcp"]);
  applyMigratePlan(first, home);

  const second = await collectMigratePlan("claude-code", home, ["mcp"]);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].action, "already-migrated");
});

test("mcp: a canonical server with a different definition is a conflict, not overwritten", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  writeClaudeMcpServer(home, "gitlab", { type: "stdio", command: "npx" });

  const first = await collectMigratePlan("claude-code", home, ["mcp"]);
  applyMigratePlan(first, home);

  writeClaudeMcpServer(home, "gitlab", { type: "stdio", command: "different-command" });
  const second = await collectMigratePlan("claude-code", home, ["mcp"]);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].action, "conflict");

  const written = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  assert.match(written, /command: npx/);
  assert.doesNotMatch(written, /different-command/);
});

test("mcp: --only skills or --only instructions excludes every MCP server from the plan", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeMcpServer(home, "gitlab", { type: "stdio", command: "npx" });

  const skillsOnly = await collectMigratePlan("claude-code", home, ["skill"]);
  assert.equal(skillsOnly.items.some((i) => i.kind === "mcp"), false);

  const instructionsOnly = await collectMigratePlan("claude-code", home, ["instructions"]);
  assert.equal(instructionsOnly.items.some((i) => i.kind === "mcp"), false);
});

test("mcp: pi is never an MCP migration source — no static config to read", async () => {
  const home = scratchHome();
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "settings.json"), "{}");
  await collectInitReport(home);

  const plan = await collectMigratePlan("pi", home, ["mcp"]);
  assert.equal(plan.present, true, "pi must actually be detected as present, otherwise this test proves nothing");
  assert.equal(plan.items.some((i) => i.kind === "mcp"), false);
});

test("an invalid --only value's message names all three valid values", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);

  let logged = "";
  const originalError = console.error;
  console.error = (msg: string) => {
    logged = msg;
  };
  try {
    await runMigrate({ from: "claude-code", only: "bogus", homeDir: home });
  } finally {
    console.error = originalError;
  }
  assert.match(logged, /skills/);
  assert.match(logged, /instructions/);
  assert.match(logged, /mcp/);
});
