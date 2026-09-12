#!/usr/bin/env node
/**
 * Minimal fake MCP server for sandboxed tests: responds to `initialize`
 * with a fixed serverInfo (see docs/implementation-plan.md §0.1's
 * probeMcpServer), and to `tools/list`/`tools/call` with two trivial
 * tools: "echo" (trellis-pi-mcp-bridge-p4's sandbox verification — a
 * real, deterministic round trip for the bridge extension to register
 * and call, without a real npm package inside the container), and "env"
 * (reads back one of this *spawned subprocess's own* env vars —
 * trellis-secrets-env-management's real proof of which value the bridge
 * actually handed it). Purely additive: every existing caller only ever
 * sent `initialize`.
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
            serverInfo: { name: "trellis-fixture-server", version: "0.0.1" },
          },
        }) + "\n",
      );
    } else if (msg.method === "tools/list") {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            tools: [
              {
                name: "echo",
                description: "Echoes back its input message",
                inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
              },
              {
                name: "env",
                description: "Reads back one of this subprocess's own env vars by name",
                inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
              },
            ],
          },
        }) + "\n",
      );
    } else if (msg.method === "tools/call" && msg.params?.name === "env") {
      const varName = msg.params?.arguments?.name ?? "";
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: process.env[varName] ?? "" }] },
        }) + "\n",
      );
    } else if (msg.method === "tools/call") {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: `echo: ${msg.params?.arguments?.message ?? ""}` }] },
        }) + "\n",
      );
    } else if (msg.method?.startsWith("notifications/")) {
      // no response expected for notifications
    }
  }
});
