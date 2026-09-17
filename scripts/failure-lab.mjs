#!/usr/bin/env node
/** Real Linux Runtime failure-isolation lab: one upstream never completes
 * initialize, while a second upstream must still register and answer. */

import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const labHome = process.env.HOME;
assert.ok(labHome, "sandbox HOME must be set");

const transport = new StdioClientTransport({
  command: "trellis",
  args: ["mcp-runtime", "--agent", "codex"],
  env: { ...process.env, HOME: labHome },
  stderr: "pipe",
});
const client = new Client({ name: "trellis-failure-lab", version: "0.0.0" }, { capabilities: {} });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  assert.ok(names.has("healthy-tool__echo"), "healthy upstream must survive a hanging upstream");
  assert.ok(names.has("trellis.skills.search"));
  assert.ok(!names.has("hanging-tool__echo"));
  const result = await client.callTool({ name: "healthy-tool__echo", arguments: { message: "healthy" } });
  assert.equal(result.content[0].text, "echo: healthy");
} finally {
  await client.close();
  await transport.close();
}

console.log("[failure-lab] PASS: hanging upstream isolated, healthy upstream usable");
