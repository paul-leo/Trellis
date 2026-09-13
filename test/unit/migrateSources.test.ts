/**
 * trellis-real-sandbox-verification: closes the gap named in P11's
 * tasks.md 4.1 and roadmap.md's P11/P13 entries — `test/unit/
 * migrate.test.ts` only ever exercised `claude-code` as a migrate
 * source, despite `collectMigratePlan`'s `PROBES` dispatch
 * (src/commands/migrate.ts) being fully symmetric by design across all
 * four agents. codex/kiro/pi as sync/mcp-sync *targets* are already
 * covered elsewhere (test/unit/sync.test.ts, test/unit/mcp.test.ts) —
 * only the migrate-*source* side was ever untested.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectInitReport } from "../../src/commands/init.js";
import { applyMigratePlan, collectMigratePlan } from "../../src/commands/migrate.js";

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "trellis-migrate-sources-"));
}

test("codex: a real skill and real instructions are both migrated (src/probes/codex.ts's real paths)", async () => {
  const home = scratchHome();
  await collectInitReport(home);

  // Presence marker: ~/.codex/config.toml must exist.
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "AGENTS.md"), "# Codex instructions\nreal content\n");
  writeFileSync(join(home, ".codex", "config.toml"), `model = "x"\ninstructions = "${join(home, ".codex", "AGENTS.md")}"\n`);

  // Codex's own skill root (docs/research.md): ~/.agents/skills.
  mkdirSync(join(home, ".agents", "skills", "codex-skill"), { recursive: true });
  writeFileSync(join(home, ".agents", "skills", "codex-skill", "SKILL.md"), "# Codex Skill\n");

  const plan = await collectMigratePlan("codex", home);
  assert.equal(plan.present, true);
  const skillItem = plan.items.find((i) => i.kind === "skill" && i.name === "codex-skill");
  const instructionsItem = plan.items.find((i) => i.kind === "instructions");
  assert.equal(skillItem?.action, "create");
  assert.equal(instructionsItem?.action, "create");

  applyMigratePlan(plan, home);
  assert.equal(readFileSync(join(home, ".trellis", "skills", "codex-skill", "SKILL.md"), "utf-8"), "# Codex Skill\n");
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), "# Codex instructions\nreal content\n");
});

test("kiro: a real skill and real instructions are both migrated (src/probes/kiro.ts's real paths)", async () => {
  const home = scratchHome();
  await collectInitReport(home);

  mkdirSync(join(home, ".kiro", "steering"), { recursive: true });
  writeFileSync(join(home, ".kiro", "steering", "CLAUDE.md"), "# Kiro instructions\nreal content\n");
  mkdirSync(join(home, ".kiro", "skills", "kiro-skill"), { recursive: true });
  writeFileSync(join(home, ".kiro", "skills", "kiro-skill", "SKILL.md"), "# Kiro Skill\n");

  const plan = await collectMigratePlan("kiro", home);
  assert.equal(plan.present, true);
  const skillItem = plan.items.find((i) => i.kind === "skill" && i.name === "kiro-skill");
  const instructionsItem = plan.items.find((i) => i.kind === "instructions");
  assert.equal(skillItem?.action, "create");
  assert.equal(instructionsItem?.action, "create");

  applyMigratePlan(plan, home);
  assert.equal(readFileSync(join(home, ".trellis", "skills", "kiro-skill", "SKILL.md"), "utf-8"), "# Kiro Skill\n");
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), "# Kiro instructions\nreal content\n");
});

test("pi: a real skill and real instructions are both migrated (src/probes/pi.ts's real paths)", async () => {
  const home = scratchHome();
  await collectInitReport(home);

  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "settings.json"), "{}\n");
  writeFileSync(join(home, ".pi", "agent", "AGENTS.md"), "# Pi instructions\nreal content\n");
  mkdirSync(join(home, ".pi", "agent", "skills", "pi-skill"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "skills", "pi-skill", "SKILL.md"), "# Pi Skill\n");

  const plan = await collectMigratePlan("pi", home);
  assert.equal(plan.present, true);
  const skillItem = plan.items.find((i) => i.kind === "skill" && i.name === "pi-skill");
  const instructionsItem = plan.items.find((i) => i.kind === "instructions");
  assert.equal(skillItem?.action, "create");
  assert.equal(instructionsItem?.action, "create");

  applyMigratePlan(plan, home);
  assert.equal(readFileSync(join(home, ".trellis", "skills", "pi-skill", "SKILL.md"), "utf-8"), "# Pi Skill\n");
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), "# Pi instructions\nreal content\n");
});

test("codex: a real stdio MCP server (with static_env) is migrated via the real codex binary (trellis-migrate-mcp-servers)", async () => {
  const home = scratchHome();
  await collectInitReport(home);

  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    join(home, ".codex", "config.toml"),
    `model = "x"\n\n[mcp_servers.gitlab]\ncommand = "npx"\nargs = ["-y", "@zereight/mcp-gitlab"]\nenv_vars = ["GITLAB_PERSONAL_ACCESS_TOKEN"]\n[mcp_servers.gitlab.env]\nGITLAB_API_URL = "https://gitlab.example.com"\n`,
  );

  const plan = await collectMigratePlan("codex", home, ["mcp"]);
  assert.equal(plan.present, true);
  assert.equal(plan.items.length, 1, JSON.stringify(plan.items));
  assert.equal(plan.items[0].action, "create");
  assert.equal(plan.items[0].name, "gitlab");
  assert.deepEqual(plan.items[0].mcpDef, {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@zereight/mcp-gitlab"],
    env: ["GITLAB_PERSONAL_ACCESS_TOKEN"],
    staticEnv: { GITLAB_API_URL: "https://gitlab.example.com" },
  });

  applyMigratePlan(plan, home);
  const written = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  assert.match(written, /gitlab:/);
  assert.match(written, /GITLAB_API_URL/);
});
