import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectInitReport } from "../../src/commands/init.js";
import { RuntimeControlProvider } from "../../src/lib/runtimeControlProvider.js";
import type { GatewayBackend, UpstreamStatus } from "../../src/lib/gatewayBackend.js";
import type { RuntimeContext } from "../../src/lib/mcpRuntime.js";

function home(): string {
  return mkdtempSync(join(tmpdir(), "trellis-runtime-control-"));
}

function backend(statuses: UpstreamStatus[] = []): GatewayBackend {
  return {
    async listTools() { return []; },
    async callTool() { return {}; },
    listStatus() { return statuses; },
    async close() {},
  };
}

function text(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.find((item) => item.type === "text")?.text ?? "";
}

test("RuntimeControlProvider: status reports Agent, delivery, counts, and sanitized upstream state", async () => {
  const value = home();
  await collectInitReport(value);
  writeFileSync(join(value, ".trellis", "managed.yaml"), "agents: [kimi-code]\n");
  mkdirSync(join(value, ".trellis", "memories"), { recursive: true });
  writeFileSync(join(value, ".trellis", "memories", "note.md"), "shared note\n");
  const context: RuntimeContext = { agentId: "kimi-code", homeDir: value };
  const provider = new RuntimeControlProvider(backend([{ name: "figma", transport: "http", status: "auth-required", detail: "Unauthorized", remediation: "trellis mcp auth figma" }]));
  const result = await provider.callTool("trellis.runtime.status", {}, context);
  const payload = JSON.parse(text(result));
  assert.equal(payload.agent.id, "kimi-code");
  assert.equal(payload.agent.managed, true);
  assert.equal(payload.providers.skills.canonicalCount, 1, "init's package-owned runtime Skill is present");
  assert.equal(payload.providers.memory.canonicalCount, 1);
  assert.equal(payload.upstream[0].status, "auth-required");
  assert.match(payload.upstream[0].remediation, /trellis mcp auth figma/);
  assert.equal(JSON.stringify(payload).includes("token"), false);
});

test("RuntimeControlProvider: Memory distinguishes missing backend from an empty ready graph", async () => {
  const value = home();
  await collectInitReport(value);
  mkdirSync(join(value, ".trellis", "memories"), { recursive: true });
  writeFileSync(join(value, ".trellis", "managed.yaml"), "agents: [kimi-code, pi]\n");
  writeFileSync(join(value, ".trellis", "mcp", "servers.yaml"), `servers:\n  memory:\n    transport: stdio\n    command: npx\n    args: ["-y", "@modelcontextprotocol/server-memory"]\n    static_env:\n      MEMORY_FILE_PATH: "~/.trellis/memories/graph.jsonl"\nroutes:\n  kimi-code:\n    mode: gateway\n  pi:\n    mode: gateway\n`);
  const provider = new RuntimeControlProvider(backend([{ name: "memory", transport: "stdio", status: "ready", detail: "connected; 8 tool(s) available" }]));
  const result = await provider.callTool("trellis.runtime.status", {}, { agentId: "kimi-code", homeDir: value });
  const payload = JSON.parse(text(result));
  assert.deepEqual(payload.providers.memory, {
    available: true,
    backendConfigured: true,
    graphPath: "~/.trellis/memories/graph.jsonl",
    graphExists: false,
    graphReadable: false,
    graphWritable: true,
    graphReady: true,
    canonicalCount: 0,
    deliveredAgents: ["kimi-code", "pi"],
    writePath: "mcp",
    extractionCommand: "trellis memory extract",
    nativeImportSupported: false,
    upstream: { status: "ready", detail: "connected; 8 tool(s) available" },
  });
});

test("RuntimeControlProvider: Instructions tool and resource read canonical agents.md", async () => {
  const value = home();
  await collectInitReport(value);
  writeFileSync(join(value, ".trellis", "agents.md"), "# shared instructions\n");
  const context: RuntimeContext = { agentId: "kimi-code", homeDir: value };
  const provider = new RuntimeControlProvider(backend());
  const toolResult = await provider.callTool("trellis.instructions.read", {}, context);
  const payload = JSON.parse(text(toolResult));
  assert.equal(payload.name, "agents.md");
  assert.equal(payload.content, "# shared instructions\n");
  assert.equal(payload.source, "canonical");
  const resource = await provider.readResource!(new URL("trellis://instructions/agents.md"), context);
  assert.equal(resource.contents[0].text, "# shared instructions\n");
});

test("RuntimeControlProvider: Agent listing distinguishes absent, unmanaged, and managed", async () => {
  const value = home();
  await collectInitReport(value);
  writeFileSync(join(value, ".trellis", "managed.yaml"), "agents: [kimi-code]\n");
  const context: RuntimeContext = { agentId: "kimi-code", homeDir: value };
  const provider = new RuntimeControlProvider(backend());
  const result = await provider.callTool("trellis.agents.list", {}, context);
  const agents = JSON.parse(text(result)).agents;
  const kimi = agents.find((agent: { id: string }) => agent.id === "kimi-code");
  const codex = agents.find((agent: { id: string }) => agent.id === "codex");
  assert.equal(kimi.managed, true);
  assert.equal(kimi.present, false);
  assert.equal(codex.managed, false);
});
