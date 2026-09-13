import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildCodexMcpReadResult,
  readClaudeCodeMcpDefs,
  readCodexMcpDefs,
  readKiroMcpDefs,
  type CodexMcpEntryRich,
} from "../../src/lib/mcpMigrateRead.js";
import { renderJsonServerEntry } from "../../src/adapters/jsonMcp.js";

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "trellis-mcp-migrate-read-"));
}

test("readClaudeCodeMcpDefs: converts a real stdio server with env names and static_env", () => {
  const home = scratchHome();
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        gitlab: { type: "stdio", command: "npx", args: ["-y", "@zereight/mcp-gitlab"], env: { GITLAB_PERSONAL_ACCESS_TOKEN: "${GITLAB_PERSONAL_ACCESS_TOKEN}", GITLAB_API_URL: "https://gitlab.example.com" } },
      },
    }),
  );
  const result = readClaudeCodeMcpDefs(home);
  assert.deepEqual(result.unsupported, []);
  assert.deepEqual(result.entries, [
    { name: "gitlab", def: { transport: "stdio", command: "npx", args: ["-y", "@zereight/mcp-gitlab"], env: ["GITLAB_PERSONAL_ACCESS_TOKEN"], staticEnv: { GITLAB_API_URL: "https://gitlab.example.com" } } },
  ]);
  rmSync(home, { recursive: true, force: true });
});

test("readClaudeCodeMcpDefs: converts a real http server with headers", () => {
  const home = scratchHome();
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { figma: { type: "http", url: "https://mcp.figma.com/mcp", headers: { Authorization: "Bearer ${FIGMA_TOKEN}" } } } }),
  );
  const result = readClaudeCodeMcpDefs(home);
  assert.deepEqual(result.entries, [{ name: "figma", def: { transport: "http", url: "https://mcp.figma.com/mcp", headers: { Authorization: "Bearer ${FIGMA_TOKEN}" } } }]);
  rmSync(home, { recursive: true, force: true });
});

test("readClaudeCodeMcpDefs: no .claude.json or no mcpServers is an empty result, not an error", () => {
  const home = scratchHome();
  assert.deepEqual(readClaudeCodeMcpDefs(home), { entries: [], unsupported: [] });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({}));
  assert.deepEqual(readClaudeCodeMcpDefs(home), { entries: [], unsupported: [] });
  rmSync(home, { recursive: true, force: true });
});

test("round-trip: renderJsonServerEntry's own output reads back to an identical McpServerDef (design.md D2 mitigation)", () => {
  const original = { transport: "stdio" as const, command: "node", args: ["server.js"], env: ["API_KEY"], staticEnv: { REGION: "us-east-1" } };
  const home = scratchHome();
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { sample: renderJsonServerEntry(original) } }));
  const result = readClaudeCodeMcpDefs(home);
  assert.deepEqual(result.entries, [{ name: "sample", def: original }]);
  rmSync(home, { recursive: true, force: true });
});

test("readKiroMcpDefs: same JSON shape, different path", () => {
  const home = scratchHome();
  mkdirSync(join(home, ".kiro", "settings"), { recursive: true });
  writeFileSync(join(home, ".kiro", "settings", "mcp.json"), JSON.stringify({ mcpServers: { tanka: { type: "stdio", command: "tanka-mcp" } } }));
  const result = readKiroMcpDefs(home);
  assert.deepEqual(result.entries, [{ name: "tanka", def: { transport: "stdio", command: "tanka-mcp" } }]);
  rmSync(home, { recursive: true, force: true });
});

test("buildCodexMcpReadResult: a stdio entry with env_vars and a matching TOML static_env table converts fully", () => {
  const entries: CodexMcpEntryRich[] = [{ name: "gitlab", enabled: true, transport: { type: "stdio", command: "npx", args: ["-y", "@zereight/mcp-gitlab"], env_vars: ["GITLAB_PERSONAL_ACCESS_TOKEN"] } }];
  const toml = `[mcp_servers.gitlab]\ncommand = "npx"\n[mcp_servers.gitlab.env]\nGITLAB_API_URL = "https://gitlab.example.com"\n`;
  const result = buildCodexMcpReadResult(entries, toml);
  assert.deepEqual(result.unsupported, []);
  assert.deepEqual(result.entries, [
    { name: "gitlab", def: { transport: "stdio", command: "npx", args: ["-y", "@zereight/mcp-gitlab"], env: ["GITLAB_PERSONAL_ACCESS_TOKEN"], staticEnv: { GITLAB_API_URL: "https://gitlab.example.com" } } },
  ]);
});

test("buildCodexMcpReadResult: a non-stdio entry is unsupported, never guessed at (design.md D2)", () => {
  const entries: CodexMcpEntryRich[] = [{ name: "figma", enabled: true, transport: { type: "http" } }];
  const result = buildCodexMcpReadResult(entries, undefined);
  assert.deepEqual(result.entries, []);
  assert.equal(result.unsupported.length, 1);
  assert.equal(result.unsupported[0].name, "figma");
  assert.match(result.unsupported[0].reason, /stdio transport/);
});

test("buildCodexMcpReadResult: missing TOML content still converts command/args/env names, just no static_env", () => {
  const entries: CodexMcpEntryRich[] = [{ name: "gitlab", enabled: true, transport: { type: "stdio", command: "npx", env_vars: ["TOKEN"] } }];
  const result = buildCodexMcpReadResult(entries, undefined);
  assert.deepEqual(result.entries, [{ name: "gitlab", def: { transport: "stdio", command: "npx", env: ["TOKEN"] } }]);
});

test("readCodexMcpDefs: an empty scoped HOME (no config, or codex binary absent) is an empty result, not a crash", () => {
  const home = scratchHome();
  const result = readCodexMcpDefs(home);
  assert.deepEqual(result, { entries: [], unsupported: [] });
  rmSync(home, { recursive: true, force: true });
});
