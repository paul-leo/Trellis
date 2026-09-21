/**
 * End-to-end proof that a "simple sub-agent call" works through the real
 * `trellis mcp-gateway` stdio process an Agent actually spawns — not just
 * against the `AgentBridgeProvider` class directly (see
 * agentBridgeProvider.test.ts for that narrower unit coverage).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cliEntry = join(repoRoot, "src", "cli.ts");
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const stubCli = join(here, "..", "fixtures", "stub-agent-cli.js");

function gatewayHome(): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-agent-bridge-gw-"));
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(join(home, ".trellis", "secrets.policy.yaml"), "allowed_vars: []\nreject_patterns: []\n");
  writeFileSync(join(home, ".trellis", "managed.yaml"), "agents: [claude-code, codex]\n");
  writeFileSync(
    join(home, ".trellis", "mcp", "agent-bridge.yaml"),
    `targets:
  codex:
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(stubCli)}, "echo", "{prompt}"]
    outputFormat: json
    tags: ["code-review"]
`,
  );
  return home;
}

test("agent bridge, end to end: claude-code's gateway can delegate a real one-shot call to codex", async () => {
  const home = gatewayHome();
  const transport = new StdioClientTransport({
    command: tsxBin,
    args: [cliEntry, "mcp-gateway", "--agent", "claude-code"],
    env: { ...process.env, HOME: home } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "trellis-agent-bridge-e2e", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);

  try {
    const { tools } = await client.listTools();
    const bridgeTool = tools.find((tool) => tool.name === "agent_bridge_run_codex");
    assert.ok(bridgeTool, `expected an "agent_bridge_run_codex" tool, got: ${tools.map((t) => t.name).join(", ")}`);
    assert.match(bridgeTool!.description ?? "", /code-review/);
    assert.ok(!tools.some((tool) => tool.name.includes("claude_code")), "must not offer to delegate to itself");

    const rejected = (await client.callTool({ name: "agent_bridge_run_codex", arguments: { prompt: "review this diff", confirm: false } })) as {
      isError?: boolean;
    };
    assert.equal(rejected.isError, true);

    const called = (await client.callTool({ name: "agent_bridge_run_codex", arguments: { prompt: "review this diff", confirm: true } })) as {
      structuredContent?: { status: string; output: string; targetAgent: string };
    };
    assert.equal(called.structuredContent?.status, "completed");
    assert.equal(called.structuredContent?.output, "echo:review this diff");
    assert.equal(called.structuredContent?.targetAgent, "codex");
  } finally {
    await client.close();
    await transport.close();
  }
});
