#!/usr/bin/env node
/**
 * Minimal fake MCP server for sandboxed tests: responds to `initialize`
 * with a fixed serverInfo, so probeMcpServer (see docs/implementation-plan.md
 * §0.1) has something real and deterministic to handshake against without
 * spawning a real npm package inside the container.
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
            capabilities: {},
            serverInfo: { name: "trellis-fixture-server", version: "0.0.1" },
          },
        }) + "\n",
      );
    }
  }
});
