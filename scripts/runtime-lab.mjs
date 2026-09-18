#!/usr/bin/env node
/**
 * Linux integration lab for the deliberately complicated multi-agent state
 * in test/fixtures/runtime-home. This runs inside the sandbox container, so
 * every write is confined to the container-local HOME created by
 * docker/entrypoint.sh.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const labHome = process.env.HOME;
assert.ok(labHome, "sandbox HOME must be set");

function runJson(args) {
  try {
    const stdout = execFileSync("trellis", args, {
      encoding: "utf8",
      env: { ...process.env, HOME: labHome },
    });
    return { code: 0, value: JSON.parse(stdout) };
  } catch (error) {
    const stdout = String(error.stdout ?? "");
    return { code: Number(error.status ?? 1), value: JSON.parse(stdout) };
  }
}

function read(path) {
  return readFileSync(path, "utf8");
}

console.log("[runtime-lab] sync native projections and extensions");
const sync = runJson(["sync", "--json"]);
assert.ok(sync.value.reports?.length === 5, "all five managed agents must be probed");

console.log("[runtime-lab] sync agent MCP configurations");
const mcp = runJson(["mcp", "sync", "--json"]);
assert.equal(mcp.code, 1, "the deliberate sentry collision must remain visible");
const mcpReports = new Map(mcp.value.reports.map((report) => [report.agent, report]));
assert.ok(mcpReports.get("claude-code").items.some((item) => item.mcpWrite?.name === "trellis-runtime"));
assert.ok(mcpReports.get("codex").items.some((item) => item.mcpWrite?.name === "trellis-runtime"));
assert.ok(mcpReports.get("kiro").items.some((item) => item.action === "conflict" && item.description.includes("sentry")));

const claudeConfig = JSON.parse(read(`${labHome}/.claude.json`));
assert.equal(claudeConfig.mcpServers["trellis-runtime"].args[0], "mcp-runtime");
assert.match(read(`${labHome}/.codex/config.toml`), /\[mcp_servers\.trellis-runtime\]/);
assert.match(read(`${labHome}/.kiro/settings/mcp.json`), /shared-tools/);
assert.doesNotMatch(read(`${labHome}/.kiro/settings/mcp.json`), /"sentry"/);
const kimiConfig = JSON.parse(read(`${labHome}/.kimi-code/mcp.json`));
assert.deepEqual(kimiConfig.mcpServers["kimi-user-owned"], { command: "node", args: ["/fixtures/sample-mcp-server.js"] });
assert.equal(kimiConfig.mcpServers["trellis-runtime"].deferred, true);
assert.deepEqual(kimiConfig.mcpServers["trellis-runtime"].args, ["mcp-runtime", "--agent", "kimi-code"]);

console.log("[runtime-lab] sync canonical memory into the shared graph");
const memory = runJson(["memory", "sync", "--json"]);
assert.equal(memory.code, 0);
assert.ok(existsSync(`${labHome}/.trellis/memories/graph.jsonl`));

console.log("[runtime-lab] audit the intentionally separated state");
const audit = runJson(["secrets", "audit", "--json"]);
assert.equal(audit.code, 0);
assert.deepEqual(audit.value.findings, []);

async function probeRuntime(agent, expectedTools, forbiddenTools) {
  const transport = new StdioClientTransport({
    command: "trellis",
    args: ["mcp-runtime", "--agent", agent],
    env: { ...process.env, HOME: labHome },
    stderr: "pipe",
  });
  const client = new Client({ name: "trellis-runtime-lab", version: "0.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = new Set(listed.tools.map((tool) => tool.name));
    for (const name of expectedTools) assert.ok(names.has(name), `${agent} must expose ${name}`);
    for (const name of forbiddenTools) assert.ok(!names.has(name), `${agent} must not expose ${name}`);
    assert.ok(names.has("trellis.skills.search"));
    const search = await client.callTool({ name: "trellis.skills.search", arguments: { query: "shared" } });
    assert.match(String(search.content[0].text), /shared-skill/);
    const resource = await client.readResource({ uri: "trellis://skills/shared-skill/SKILL.md" });
    assert.match(String(resource.contents[0].text), /# Shared skill/);
    const memory = await client.callTool({ name: "trellis.memory.search", arguments: { query: "canonical memory" } });
    assert.match(String(memory.content[0].text), /operator-note/);
    const memoryResource = await client.readResource({ uri: "trellis://memories/operator-note.md" });
    assert.match(String(memoryResource.contents[0].text), /shared memory sync path/);
  } finally {
    await client.close();
    await transport.close();
  }
}

console.log("[runtime-lab] verify agent-specific runtime views");
await probeRuntime("claude-code", ["shared-tools__echo", "claude-private-tool__echo"], ["codex-private-tool__echo"]);
await probeRuntime("codex", ["shared-tools__echo", "codex-private-tool__echo"], ["claude-private-tool__echo"]);
await probeRuntime("pi", ["shared-tools__echo"], ["claude-private-tool__echo", "codex-private-tool__echo"]);
await probeRuntime("kimi-code", ["shared-tools__echo"], ["claude-private-tool__echo", "codex-private-tool__echo", "kiro-private-tool__echo"]);

console.log("[runtime-lab] PASS: isolated Linux multi-agent runtime scenario");
