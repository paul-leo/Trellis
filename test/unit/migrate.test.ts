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
import { applyMigratePlan, collectMigratePlan, isSafeReclassification, runMigrate } from "../../src/commands/migrate.js";

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

// Found via real-machine dogfooding: a real `mcp-router` server in a
// real Kiro config, with its token written as a literal (not a `${VAR}`
// reference) — `resolveMcpPlan`'s own guard only ever protected the
// sync-OUT boundary; canonical itself had no guard on the way IN.

test("mcp: a literal credential in the source agent's config is refused, never written to canonical", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  // The exact real shape: a literal (not `${VAR}`) value under `env` —
  // the migrate reader reclassifies this into `staticEnv` on the way in
  // (src/lib/mcpMigrateRead.ts's splitJsonEnvMap), which is where
  // findLiteralSecret's own field scan looks.
  writeClaudeMcpServer(home, "mcp-router", {
    type: "stdio",
    command: "npx",
    args: ["-y", "@mcp_router/cli@latest", "connect"],
    env: { MCPR_TOKEN: "mcpr_iFNlmM3ee22GSUCREMbfmo49fAy3zQ5J" },
  });

  const plan = await collectMigratePlan("claude-code", home, ["mcp"]);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].action, "conflict");
  assert.match(plan.items[0].detail, /literal pattern/);
  assert.match(plan.items[0].remediation ?? "", /environment variable/);

  applyMigratePlan(plan, home);
  const written = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  assert.ok(!written.includes("mcpr_iFNlmM3ee22GSUCREMbfmo49fAy3zQ5J"), "the real token must never reach canonical, even transiently");
  assert.ok(!written.includes("mcp-router"), "a refused server is not written at all, not written-then-flagged");
});

test("mcp: a literal credential is refused ahead of every other server in the same migrate run", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        "mcp-router": { type: "stdio", command: "npx", env: { MCPR_TOKEN: "mcpr_iFNlmM3ee22GSUCREMbfmo49fAy3zQ5J" } },
        gitlab: { type: "stdio", command: "npx", args: ["-y", "@zereight/mcp-gitlab"] },
      },
    }),
  );

  const plan = await collectMigratePlan("claude-code", home, ["mcp"]);
  const byName = Object.fromEntries(plan.items.map((item) => [item.name, item.action]));
  assert.equal(byName["mcp-router"], "conflict");
  assert.equal(byName["gitlab"], "create", "one refused server must not block another, unrelated one");

  applyMigratePlan(plan, home);
  const written = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  assert.match(written, /gitlab:/);
  assert.ok(!written.includes("mcp-router"));
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

test("isSafeReclassification: a staticEnv value that now classifies as envAliases (same resolved text) is safe", () => {
  const existing = { transport: "stdio" as const, command: "npx", staticEnv: { OPENAPI_MCP_HEADERS: "${NOTION_OPENAPI_MCP_HEADERS}" } };
  const def = { transport: "stdio" as const, command: "npx", envAliases: { OPENAPI_MCP_HEADERS: "NOTION_OPENAPI_MCP_HEADERS" } };
  assert.equal(isSafeReclassification(existing, def), true);
});

test("isSafeReclassification: a difference in command alongside an otherwise-identical env classification is not safe", () => {
  const existing = { transport: "stdio" as const, command: "npx", staticEnv: { OPENAPI_MCP_HEADERS: "${NOTION_OPENAPI_MCP_HEADERS}" } };
  const def = { transport: "stdio" as const, command: "different-command", envAliases: { OPENAPI_MCP_HEADERS: "NOTION_OPENAPI_MCP_HEADERS" } };
  assert.equal(isSafeReclassification(existing, def), false);
});

test("isSafeReclassification: an identical classification with a genuinely different resolved value is not safe", () => {
  const existing = { transport: "stdio" as const, command: "npx", staticEnv: { OPENAPI_MCP_HEADERS: "${NOTION_OPENAPI_MCP_HEADERS}" } };
  const def = { transport: "stdio" as const, command: "npx", staticEnv: { OPENAPI_MCP_HEADERS: "${SOME_OTHER_HEADERS}" } };
  assert.equal(isSafeReclassification(existing, def), false);
});

test("mcp: a stale staticEnv entry that now classifies as envAliases is a safe reclassification, not a conflict", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  // Simulates canonical data migrated before trellis-migrate-env-var-alias
  // shipped: the differently-named reference was misclassified as a
  // literal staticEnv value.
  writeFileSync(
    join(home, ".trellis", "mcp", "servers.yaml"),
    'servers:\n  notion:\n    transport: stdio\n    command: npx\n    static_env:\n      OPENAPI_MCP_HEADERS: "${NOTION_OPENAPI_MCP_HEADERS}"\n',
  );
  writeClaudeMcpServer(home, "notion", { type: "stdio", command: "npx", env: { OPENAPI_MCP_HEADERS: "${NOTION_OPENAPI_MCP_HEADERS}" } });

  const plan = await collectMigratePlan("claude-code", home, ["mcp"]);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].action, "reclassify");
  assert.equal(plan.items[0].name, "notion");

  applyMigratePlan(plan, home);
  const written = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  assert.match(written, /env_aliases:/);
  assert.match(written, /OPENAPI_MCP_HEADERS: NOTION_OPENAPI_MCP_HEADERS/);
  assert.doesNotMatch(written, /static_env:/);

  const second = await collectMigratePlan("claude-code", home, ["mcp"]);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].action, "already-migrated", "must not re-reclassify forever — the repaired entry is now the stable state");
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
