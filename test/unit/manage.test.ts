import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyManagePlan, collectManagePlan, parseManageArgs, runManage } from "../../src/commands/manage.js";
import { runRollback } from "../../src/commands/rollback.js";

function homeWithManaged(agents: string): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-manage-"));
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "managed.yaml"), `agents: [${agents}]\n`);
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "servers: {}\n");
  return home;
}

test("manage planning: set is exact and persists stable ALL_AGENTS order", () => {
  const home = homeWithManaged("claude-code, codex, kiro, pi");
  const result = collectManagePlan("set", "pi,claude-code", home);
  assert.ok("plan" in result);
  assert.deepEqual(result.plan.desired, ["claude-code", "pi"]);
  assert.deepEqual(result.plan.removed, ["codex", "kiro"]);
});

test("manage planning: add unions and remove subtracts", () => {
  const home = homeWithManaged("claude-code, codex");
  const add = collectManagePlan("add", "pi", home);
  const remove = collectManagePlan("remove", "codex", home);
  assert.ok("plan" in add && "plan" in remove);
  assert.deepEqual(add.plan.desired, ["claude-code", "codex", "pi"]);
  assert.deepEqual(remove.plan.desired, ["claude-code"]);
});

test("manage planning: set none is valid; none for add/remove and unknown ids refuse atomically", () => {
  const home = homeWithManaged("codex");
  const empty = collectManagePlan("set", "none", home);
  const badNone = collectManagePlan("remove", "none", home);
  const badId = collectManagePlan("set", "codex,unknown", home);
  assert.ok("plan" in empty);
  assert.deepEqual(empty.plan.desired, []);
  assert.ok("error" in badNone);
  assert.ok("error" in badId);
  assert.equal(readFileSync(join(home, ".trellis", "managed.yaml"), "utf8"), "agents: [codex]\n");
});

test("manage args: validates operation, arity, and flags before execution", () => {
  assert.deepEqual(parseManageArgs(["set", "claude-code,pi", "--dry-run", "--json"]), {
    operation: "set", ids: "claude-code,pi", dryRun: true, json: true,
  });
  assert.ok("error" in parseManageArgs(["list", "codex"]));
  assert.ok("error" in parseManageArgs(["set"]));
  assert.ok("error" in parseManageArgs(["remove", "codex", "--force"]));
  assert.ok("error" in parseManageArgs(["unknown"]));
});

test("manage apply: writes only managed.yaml and preserves detached native state byte-for-byte", () => {
  const home = homeWithManaged("claude-code, codex, kiro, pi");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".kiro", "settings"), { recursive: true });
  const codex = join(home, ".codex", "config.toml");
  const kiro = join(home, ".kiro", "settings", "mcp.json");
  writeFileSync(codex, "user codex state\n");
  writeFileSync(kiro, "user kiro state\n");
  const result = collectManagePlan("set", "claude-code,pi", home);
  assert.ok("plan" in result);
  applyManagePlan(result.plan, home);
  assert.equal(readFileSync(join(home, ".trellis", "managed.yaml"), "utf8"), "agents: [claude-code, pi]\n");
  assert.equal(readFileSync(codex, "utf8"), "user codex state\n");
  assert.equal(readFileSync(kiro, "utf8"), "user kiro state\n");
});

test("manage apply: changed write creates one backup and rollback restores exact previous bytes", async () => {
  const home = homeWithManaged("codex, pi");
  const before = readFileSync(join(home, ".trellis", "managed.yaml"), "utf8");
  const result = collectManagePlan("set", "claude-code,pi", home);
  assert.ok("plan" in result);
  applyManagePlan(result.plan, home);
  const runs = readdirSync(join(home, ".trellis", "backups"));
  assert.equal(runs.length, 1);
  assert.match(runs[0], /manage-set$/);
  assert.equal((await runRollback({ homeDir: home })).exitCode, 0);
  assert.equal(readFileSync(join(home, ".trellis", "managed.yaml"), "utf8"), before);
});

test("manage run: dry-run and no-op create no backup", () => {
  const home = homeWithManaged("claude-code, pi");
  assert.equal(runManage({ operation: "set", ids: "codex", dryRun: true, json: true }, { homeDir: home }).exitCode, 0);
  assert.equal(readFileSync(join(home, ".trellis", "managed.yaml"), "utf8"), "agents: [claude-code, pi]\n");
  assert.equal(runManage({ operation: "set", ids: "pi,claude-code", dryRun: false, json: true }, { homeDir: home }).exitCode, 0);
  assert.equal(existsSync(join(home, ".trellis", "backups")), false);
});
