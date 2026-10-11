#!/usr/bin/env node
/**
 * A fake MCP server that connects cleanly but exposes zero tools — the
 * mcp-router "connected but empty" degradation mode
 * (trellis-mcp-status-credential-health tasks.md 2.2). Same wire
 * discipline as sample-mcp-server.js, minus the tools.
 */
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === "initialize") {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "trellis-fixture-empty-server", version: "0.0.1" },
          },
        }) + "\n",
      );
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }) + "\n");
    } else if (msg.id !== undefined) {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } }) + "\n",
      );
    }
  }
});
