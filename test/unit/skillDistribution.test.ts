import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadCanonicalSource } from "../../src/core/canonical.js";
import { collectSkillList, runSkillAdd, applySkillScopeWithSync, collectSkillScopePlan } from "../../src/commands/skill.js";
import { collectSyncReport } from "../../src/commands/sync.js";
import { SkillProvider } from "../../src/lib/skillProvider.js";
import { scratchHome, seedAgentPresence, seedCanonical, seedSkillScopes } from "../helpers/home.js";

function fixture() {
  const home = scratchHome("skill-distribution");
  seedCanonical(home, { managed: ["claude-code", "codex"], instructions: "# shared\n", serversYaml: "servers: {}\n" });
  seedAgentPresence(home, ["claude-code", "codex", "pi"]);
  const add = (name: string) => {
    const dir = join(home, ".trellis", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n`);
    return dir;
  };
  return { home, add };
}

test("unregistered/invalid skills are paused in native delivery and every Runtime read", async () => {
  const { home, add } = fixture();
  for (const name of ["pending", "typo", "wrong-shape", "valid"]) add(name);
  writeFileSync(join(home, ".trellis", "scope.yaml"), "skills:\n  typo: [codxe]\n  wrong-shape: codex\n  valid: [codex]\n");
  const canonical = loadCanonicalSource(home);
  for (const name of ["pending", "typo", "wrong-shape"]) assert.deepEqual(canonical.skills.find((skill) => skill.name === name)?.scope, []);
  const report = await collectSyncReport({ homeDir: home, target: "skills", globalOnly: true });
  assert.ok(report.diagnostics?.some((entry) => entry.includes("pending") && entry.includes("paused")));
  assert.deepEqual(readdirSync(join(home, ".agents", "skills")), ["valid"]);
  const provider = new SkillProvider();
  const context = { homeDir: home, agentId: "codex" as const };
  assert.equal((await provider.callTool("trellis.skills.read", { name: "pending" }, context)).isError, true);
  assert.throws(() => provider.readResource(new URL("trellis://skills/pending/SKILL.md"), context));
  assert.ok(provider.listResources(context).every((entry) => !entry.uri.includes("pending")));
});

test("pausing an unregistered skill removes owned links and preserves independent directories", async () => {
  const { home, add } = fixture();
  const pending = add("pending");
  add("foreign");
  const root = join(home, ".claude", "skills");
  mkdirSync(join(root, "foreign"), { recursive: true });
  writeFileSync(join(root, "foreign", "SKILL.md"), "independent content\n");
  symlinkSync(pending, join(root, "pending"));
  await collectSyncReport({ homeDir: home, target: "skills", globalOnly: true });
  assert.equal(existsSync(join(root, "pending")), false);
  assert.equal(readFileSync(join(root, "foreign", "SKILL.md"), "utf8"), "independent content\n");
  assert.equal(existsSync(pending), true, "pausing keeps the canonical source");
});

test("agent-filtered skill lists match actual links and show missing delivery before sync", async () => {
  const { home, add } = fixture();
  for (const name of ["shared", "claude-only", "codex-only"]) add(name);
  seedSkillScopes(home, ["shared"], ["claude-code", "codex"]);
  seedSkillScopes(home, ["claude-only"], ["claude-code"]);
  seedSkillScopes(home, ["codex-only"], ["codex"]);
  assert.ok(collectSkillList(home, "codex").every((entry) => entry.delivery?.state === "missing"));
  await collectSyncReport({ homeDir: home, target: "skills", globalOnly: true });
  for (const [agent, root] of [["claude-code", ".claude"], ["codex", ".agents"]] as const) {
    const entries = collectSkillList(home, agent);
    assert.deepEqual(entries.map((entry) => entry.name).sort(), readdirSync(join(home, root, "skills")).sort());
    assert.ok(entries.every((entry) => entry.registered && entry.delivery?.state === "linked"));
  }
});

test("--all registration never grows automatically when another agent becomes managed", async () => {
  const { home, add } = fixture();
  add("reviewed");
  await applySkillScopeWithSync(collectSkillScopePlan("reviewed", { all: true }, home), { homeDir: home });
  writeFileSync(join(home, ".trellis", "managed.yaml"), "agents: [claude-code, codex, pi]\n");
  await collectSyncReport({ homeDir: home, target: "skills", globalOnly: true });
  assert.deepEqual(collectSkillList(home, "pi"), []);
  assert.equal(existsSync(join(home, ".pi", "agent", "skills", "reviewed")), false);
});

test("local import requires a scope selection, records it, and can rescope identical content", async () => {
  const { home } = fixture();
  const source = join(home, "source");
  mkdirSync(source);
  writeFileSync(join(source, "SKILL.md"), "---\nname: imported\ndescription: fixture\n---\n");
  assert.equal((await runSkillAdd("imported", source, { homeDir: home, json: true })).exitCode, 1);
  assert.equal(existsSync(join(home, ".trellis", "skills", "imported")), false);
  assert.equal((await runSkillAdd("imported", source, { homeDir: home, json: true, selection: { agents: "codex" } })).exitCode, 0);
  assert.equal(existsSync(join(home, ".agents", "skills", "imported")), true);
  assert.equal(existsSync(join(home, ".claude", "skills", "imported")), false);
  assert.equal((await runSkillAdd("imported", source, { homeDir: home, json: true, selection: { none: true } })).exitCode, 0);
  assert.deepEqual(collectSkillList(home).find((entry) => entry.name === "imported")?.scope, []);
  assert.equal(existsSync(join(home, ".agents", "skills", "imported")), false);
});
