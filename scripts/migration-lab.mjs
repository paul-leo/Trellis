#!/usr/bin/env node
/**
 * Kiro -> Codex migration acceptance lab. The important assertion is not
 * merely that canonical files were written: the target agent's runtime is
 * started afterward and must actually expose the migrated skill and MCP tool.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const labHome = process.env.HOME;
assert.ok(labHome, "sandbox HOME must be set");

function runJson(args) {
  try {
    const stdout = execFileSync("trellis", args, { encoding: "utf8", env: { ...process.env, HOME: labHome } });
    return { code: 0, value: JSON.parse(stdout) };
  } catch (error) {
    return { code: Number(error.status ?? 1), value: JSON.parse(String(error.stdout ?? "")) };
  }
}

function read(path) {
  return readFileSync(path, "utf8");
}

const sourceMcpPath = `${labHome}/.kiro/settings/mcp.json`;
const sourceSkillPath = `${labHome}/.kiro/skills/kiro-source-skill/SKILL.md`;
const sourceMcpBefore = read(sourceMcpPath);
const sourceSkillBefore = read(sourceSkillPath);

console.log("[migration-lab] migrate Kiro into canonical and onboard Codex");
const onboard = runJson([
  "onboard",
  "--agent",
  "kiro",
  "--manage",
  "codex",
  "--selection",
  `${labHome}/selection.yaml`,
  "--json",
]);
assert.equal(onboard.code, 0, JSON.stringify(onboard.value));
assert.equal(onboard.value.source, "kiro");
assert.deepEqual(onboard.value.managedAgents, ["codex"]);

const canonicalServers = read(`${labHome}/.trellis/mcp/servers.yaml`);
assert.match(canonicalServers, /migrated-tool:/);
assert.match(canonicalServers, /runtime:/);
assert.match(canonicalServers, /codex: mcp/);
assert.match(read(`${labHome}/.trellis/skills/kiro-source-skill/SKILL.md`), /# Kiro source skill/);
assert.match(read(`${labHome}/.codex/config.toml`), /\[mcp_servers\.trellis-runtime\]/);

console.log("[migration-lab] verify migration never mutates the Kiro source");
assert.equal(read(sourceMcpPath), sourceMcpBefore);
assert.equal(read(sourceSkillPath), sourceSkillBefore);

console.log("[migration-lab] verify post-migration Codex Runtime usability");
const transport = new StdioClientTransport({
  command: "trellis",
  args: ["mcp-runtime", "--agent", "codex"],
  env: { ...process.env, HOME: labHome },
  stderr: "pipe",
});
const client = new Client({ name: "trellis-migration-lab", version: "0.0.0" }, { capabilities: {} });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  assert.ok(names.has("trellis.skills.search"));
  assert.ok(names.has("echo"));
  const called = await client.callTool({ name: "echo", arguments: { message: "migrated and usable" } });
  assert.equal(called.content[0].text, "echo: migrated and usable");
  const resource = await client.readResource({ uri: "trellis://skills/kiro-source-skill/SKILL.md" });
  assert.match(String(resource.contents[0].text), /# Kiro source skill/);
} finally {
  await client.close();
  await transport.close();
}

console.log("[migration-lab] verify the closed-loop health and secret checks");
const doctor = runJson(["doctor", "--json"]);
assert.equal(doctor.code, 0, JSON.stringify(doctor.value));
assert.deepEqual(doctor.value.findings, []);
const audit = runJson(["secrets", "audit", "--json"]);
assert.equal(audit.code, 0, JSON.stringify(audit.value));
assert.deepEqual(audit.value.findings, []);

console.log("[migration-lab] PASS: Kiro -> Codex migration is usable after migration");
