#!/usr/bin/env node
/** Minimal Codex CLI probe surface for the isolated sandbox only. It never
 * starts an MCP server; it reports the static names from config.toml so
 * Trellis doctor can verify the generated runtime entry without installing
 * or authenticating a real Codex client in Docker. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-sandbox-fixture 0.0.1");
  process.exit(0);
}

if (args[0] === "mcp" && args[1] === "list") {
  const path = join(process.env.HOME ?? ".", ".codex", "config.toml");
  const content = existsSync(path) ? readFileSync(path, "utf8") : "";
  const entries = [...content.matchAll(/^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]/gm)].map((match) => ({
    name: match[1] ?? match[2],
    enabled: true,
    transport: { type: "stdio", command: "node", args: [] },
  }));
  console.log(JSON.stringify(entries));
  process.exit(0);
}

console.error(`unsupported sandbox codex command: ${args.join(" ")}`);
process.exit(1);
