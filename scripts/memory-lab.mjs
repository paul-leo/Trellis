#!/usr/bin/env node
/**
 * Shared-memory acceptance lab. It runs in the disposable Linux sandbox and
 * proves that onboarding enables one graph, then Kimi Code and pi Runtime
 * edges can write/read the same graph over the real MCP stdio protocol.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
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
    return { code: Number(error.status ?? 1), value: JSON.parse(String(error.stdout ?? "{}")) };
  }
}

function text(result) {
  return result.content?.find((item) => item.type === "text")?.text ?? "";
}

function writeNpxShim() {
  const bin = join(labHome, "memory-bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "npx");
  writeFileSync(shim, `#!/bin/sh
case "$*" in
  *"@modelcontextprotocol/server-memory"*) exec node /fixtures/memory-mcp-server.js ;;
  *) exec /usr/local/bin/npx "$@" ;;
esac
`);
  chmodSync(shim, 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
}

async function connect(agent) {
  const transport = new StdioClientTransport({
    command: "trellis",
    args: ["mcp-runtime", "--agent", agent],
    env: { ...process.env, HOME: labHome },
    stderr: "ignore",
  });
  const client = new Client({ name: `memory-lab-${agent}`, version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

console.log("[memory-lab] enable shared Memory only through onboard");
writeNpxShim();
const onboard = runJson(["onboard", "--agent", "kimi-code", "--manage", "pi,kimi-code", "--mcp-mode", "gateway", "--memory", "on", "--json"]);
assert.equal(onboard.code, 0, JSON.stringify(onboard.value));
assert.deepEqual(onboard.value.memory, { current: "on", previous: "off", changed: true });
assert.equal(onboard.value.memorySyncResult.configured, true);

const servers = readFileSync(join(labHome, ".trellis", "mcp", "servers.yaml"), "utf8");
assert.match(servers, /memory:/);
assert.match(servers, /MEMORY_FILE_PATH/);
assert.match(servers, /pi:\n    mode: gateway\n    servers:\n      - fixture-tools\n      - memory/);
assert.match(servers, /kimi-code:\n    mode: gateway\n    servers:\n      - fixture-tools\n      - memory/);
const kimiConfig = JSON.parse(readFileSync(join(labHome, ".kimi-code", "mcp.json"), "utf8"));
assert.equal(kimiConfig.mcpServers["trellis-gateway"].args[0], "mcp-gateway");
assert.ok(existsSync(join(labHome, ".pi", "agent", "extensions", "trellis-mcp-bridge.js")));

console.log("[memory-lab] Kimi writes and pi reads the same graph");
const kimi = await connect("kimi-code");
const pi = await connect("pi");
const marker = `trellis-memory-lab-${process.pid}`;
try {
  const kimiTools = await kimi.client.listTools();
  const piTools = await pi.client.listTools();
  assert.ok(kimiTools.tools.some((tool) => tool.name === "create_entities"));
  assert.ok(piTools.tools.some((tool) => tool.name === "search_nodes"));
  assert.ok(kimiTools.tools.some((tool) => tool.name === "trellis.memory.search"));
  const runtimeStatus = JSON.parse(text(await kimi.client.callTool({ name: "trellis.runtime.status", arguments: {} })));
  assert.equal(runtimeStatus.providers.memory.backendConfigured, true);
  assert.equal(runtimeStatus.providers.memory.graphReady, true);
  assert.deepEqual(runtimeStatus.providers.memory.deliveredAgents, ["pi", "kimi-code"]);

  const created = await kimi.client.callTool({
    name: "create_entities",
    arguments: { entities: [{ name: marker, entityType: "agent-note", observations: ["written by Kimi and shared with pi"] }] },
  });
  assert.match(text(created), new RegExp(marker));

  const searched = await pi.client.callTool({ name: "search_nodes", arguments: { query: marker } });
  assert.match(text(searched), new RegExp(marker));

  console.log("[memory-lab] graph-to-canonical extraction is explicit and conflict-safe");
  const extracted = runJson(["memory", "extract", "--json"]);
  assert.equal(extracted.code, 0, JSON.stringify(extracted.value));
  assert.ok(extracted.value.plan.items.some((item) => item.name === marker && item.action === "create"));
  assert.ok(existsSync(join(labHome, ".trellis", "memories", `${marker}.md`)));

  const conflict = runJson(["memory", "sync", "--json"]);
  assert.equal(conflict.code, 1, "canonical sync must refuse to overwrite the non-Trellis entity");
  assert.ok(conflict.value.plan.items.some((item) => item.name === marker && item.action === "conflict"));

  const deleted = await pi.client.callTool({ name: "delete_entities", arguments: { entityNames: [marker] } });
  assert.match(text(deleted), new RegExp(marker));
} finally {
  await kimi.client.close();
  await kimi.transport.close();
  await pi.client.close();
  await pi.transport.close();
}

console.log("[memory-lab] PASS: Kimi and pi share one Trellis-managed Memory graph");
