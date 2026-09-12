#!/usr/bin/env node
/**
 * Reproduces the real failure this project found live (trellis-mcp-
 * connect-timeout's Why): a stdio process that stays alive and never
 * writes a byte back once its stdin is a readable pipe. Two modes,
 * selected by argv[2]:
 *
 * - "before-initialize" (default): never responds to anything —
 *   `client.connect()` itself hangs forever.
 * - "before-tools-list": answers `initialize` correctly, then goes
 *   silent — `client.connect()` resolves, `listTools()` hangs forever.
 *
 * A trailing argv marker (argv[3]) exists purely so tests can
 * `pkill -f` this exact invocation without touching unrelated node
 * processes — same convention as sample-mcp-server.js.
 */
const mode = process.argv[2] ?? "before-initialize";

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
    if (mode === "before-tools-list" && msg.method === "initialize") {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "trellis-hanging-fixture", version: "0.0.1" },
          },
        }) + "\n",
      );
    }
    // Every other message (including tools/list in either mode, and
    // everything in "before-initialize" mode) gets no response — that
    // silence is the entire point of this fixture.
  }
});
