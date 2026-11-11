import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { collectInitReport } from "../../src/commands/init.js";
import { collectMcpSyncReport } from "../../src/commands/mcp.js";
import { collectOnboardPlan } from "../../src/commands/onboard.js";
import { collectSyncReport } from "../../src/commands/sync.js";
import { loadCanonicalSource } from "../../src/core/canonical.js";
import { ALL_AGENTS, type AgentId, type McpConfig } from "../../src/core/types.js";
import { SkillProvider } from "../../src/lib/skillProvider.js";
import { memoryBackendAgents } from "../../src/lib/memoryDelivery.js";
import { scratchHome, seedAgentPresence, seedSkillScopes } from "../helpers/home.js";

const name = "trellis-memory";
const roots: Partial<Record<AgentId, string>> = { "claude-code": ".claude/skills", codex: ".agents/skills", pi: ".pi/agent/skills" };
const graphServer = { transport: "stdio" as const, command: "node", static_env: { MEMORY_FILE_PATH: "~/graph.jsonl" } };

async function fixture() {
  const home = scratchHome("memory-skill");
  await collectInitReport(home);
  seedAgentPresence(home, ALL_AGENTS);
  writeFileSync(join(home, ".trellis/managed.yaml"), stringify({ agents: ALL_AGENTS }));
  return home;
}

function configure(home: string, data: Record<string, unknown>) {
  writeFileSync(join(home, ".trellis/mcp/servers.yaml"), stringify({ known_host_injected: [], ...data }));
}

test("memory guide is unavailable in native and Runtime delivery before backend enablement", async () => {
  const home = await fixture();
  await collectSyncReport({homeDir: home, target: "skills", globalOnly: true});
  const provider = new SkillProvider();
  for (const agentId of ALL_AGENTS) {
    assert.equal((await provider.callTool("trellis.skills.read", {name}, {homeDir: home, agentId})).isError, true);
    assert.ok(!provider.listSkillEntries({homeDir: home, agentId}).some(entry => entry.frontmatter.name === name));
  }
  for (const root of Object.values(roots)) assert.equal(existsSync(join(home, root!, name)), false);
});

test("MCP sync delivers the memory guide with tools and leaves unrelated skills untouched", async () => {
  const home = await fixture();
  configure(home, {servers: {memory: {...graphServer, agents: ["claude-code", "codex", "pi"]}}});
  const unrelated = join(home, ".trellis/skills/unrelated");
  mkdirSync(unrelated);
  writeFileSync(join(unrelated, "SKILL.md"), "---\nname: unrelated\ndescription: fixture\n---\n");
  seedSkillScopes(home, ["unrelated"]);
  await collectMcpSyncReport({homeDir: home, globalOnly: true});
  for (const root of Object.values(roots)) {
    assert.ok(existsSync(join(home, root!, name)));
    assert.equal(existsSync(join(home, root!, "unrelated")), false);
  }
  const again = await collectMcpSyncReport({homeDir: home, globalOnly: true, dryRun: true});
  assert.deepEqual(again.reports.flatMap(report => report.items), []);
});

test("memory guide scope follows backend scope, explicit direct/gateway routes and Runtime-only delivery", async () => {
  const home = await fixture();
  configure(home, {
    servers: {memory: {...graphServer, agents: ["claude-code", "codex", "pi", "kimi-code", "zcode"]}},
    routes: {
      "claude-code": {mode: "gateway", servers: ["memory"]},
      codex: {mode: "direct", servers: []},
      pi: {mode: "gateway", servers: ["memory"]},
      "kimi-code": {mode: "gateway", servers: ["memory"]},
      zcode: {mode: "hub"},
    },
    runtime: {delivery: {"kimi-code": "mcp", zcode: "mcp"}},
  });
  const expected: AgentId[] = ["claude-code", "pi", "kimi-code"];
  const canonical = loadCanonicalSource(home);
  assert.deepEqual(canonical.skills.find(skill => skill.name === name)?.scope, expected);
  const provider = new SkillProvider();
  for (const agentId of ALL_AGENTS) {
    const context = {homeDir: home, agentId};
    const available = expected.includes(agentId);
    assert.equal(provider.listSkillEntries(context).some(entry => entry.frontmatter.name === name), available);
    assert.equal((await provider.callTool("trellis.skills.read", {name}, context)).isError === true, !available);
    if (!available) assert.throws(() => provider.readResource(new URL(`trellis://skills/${name}/SKILL.md`), context));
  }
});

test("disabling the backend or narrowing its route withdraws owned guide links and Runtime reads", async () => {
  const home = await fixture();
  configure(home, {servers: {memory: graphServer}});
  await collectMcpSyncReport({homeDir: home, globalOnly: true});
  configure(home, {servers: {memory: graphServer}, routes: {codex: {mode: "direct", servers: []}}});
  await collectMcpSyncReport({homeDir: home, globalOnly: true});
  assert.equal(existsSync(join(home, ".agents/skills", name)), false);
  assert.equal(existsSync(join(home, ".claude/skills", name)), true);
  configure(home, {servers: {memory: {...graphServer, enabled: false}}});
  await collectMcpSyncReport({homeDir: home, globalOnly: true});
  for (const root of Object.values(roots)) assert.equal(existsSync(join(home, root!, name)), false);
  const provider = new SkillProvider();
  assert.equal((await provider.callTool("trellis.skills.read", {name}, {homeDir: home, agentId: "claude-code"})).isError, true);
  assert.ok(existsSync(join(home, ".trellis/skills", name, "SKILL.md")), "disabling preserves the canonical template");
});

test("onboarding previews and applies guide delivery against newly enabled memory and newly managed agents", async () => {
  const home = scratchHome("memory-skill-onboard");
  await collectInitReport(home);
  seedAgentPresence(home, ["claude-code", "codex", "pi"]);
  const before = readFileSync(join(home, ".trellis/mcp/servers.yaml"), "utf8");
  const opts = {homeDir: home, manage: "claude-code,codex,pi", memory: "on", memoryMigrate: "off", json: true};
  const preview = await collectOnboardPlan({...opts, dryRun: true});
  assert.equal(preview.refusal, undefined);
  const creates = preview.syncReport?.reports.flatMap(report => report.items).filter(item => item.kind === "skill" && basename(item.target) === name);
  assert.equal(creates?.length, 3);
  assert.equal(readFileSync(join(home, ".trellis/mcp/servers.yaml"), "utf8"), before);
  for (const root of Object.values(roots)) assert.equal(existsSync(join(home, root!, name)), false);
  const applied = await collectOnboardPlan(opts);
  assert.equal(applied.refusal, undefined);
  assert.ok(!applied.verdict.some(item => item.severity === "blocked"));
  for (const root of Object.values(roots)) assert.ok(existsSync(join(home, root!, name)));
});

test("legacy gateway and hub routing are consistent with memory guide reachability", () => {
  const mcp: McpConfig = {servers: {memory: {transport: "stdio", command: "node"}}, knownHostInjected: [], gateway: {enabled: true, agents: ["codex"]}, hub: {url: "https://example.invalid/mcp"}};
  assert.deepEqual(memoryBackendAgents(mcp, ["claude-code", "codex", "pi"]), ["codex"]);
  mcp.routes = {pi: {mode: "direct", servers: ["memory"]}, codex: {mode: "gateway", servers: []}};
  assert.deepEqual(memoryBackendAgents(mcp, ["claude-code", "codex", "pi"]), ["pi"]);
});

test("MCP sync provisions the guide for an older installation without requiring a separate init", async () => {
  const home = await fixture();
  const dir = join(home, ".trellis/skills", name);
  rmSync(dir, {recursive: true});
  configure(home, {servers: {memory: {...graphServer, agents: ["kimi-code"]}}, runtime: {delivery: {"kimi-code": "mcp"}}});
  const preview = await collectMcpSyncReport({homeDir: home, globalOnly: true, dryRun: true});
  assert.equal(preview.memorySkill?.action, "create");
  assert.equal(existsSync(dir), false);
  const applied = await collectMcpSyncReport({homeDir: home, globalOnly: true});
  assert.equal(applied.memorySkill?.action, "create");
  assert.ok(existsSync(join(dir, "SKILL.md")));
  const read = await new SkillProvider().callTool("trellis.skills.read", {name}, {homeDir: home, agentId: "kimi-code"});
  assert.notEqual(read.isError, true);
});
