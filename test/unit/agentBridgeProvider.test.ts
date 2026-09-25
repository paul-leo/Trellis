import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentBridgeProvider } from "../../src/lib/agentBridgeProvider.js";
import { DELEGATION_DEPTH_ENV, agentBridgePath } from "../../src/lib/agentBridge.js";
import type { RuntimeContext } from "../../src/lib/mcpRuntime.js";

const STUB_CLI = join(process.cwd(), "test/fixtures/stub-agent-cli.js");

function home(): string { return mkdtempSync(join(tmpdir(), "trellis-agent-bridge-provider-")); }

function writeConfig(homeDir: string): void {
  mkdirSync(join(homeDir, ".trellis", "mcp"), { recursive: true });
  const yaml = [
    "targets:",
    "  codex:",
    `    command: "${process.execPath.replaceAll("\\", "\\\\")}"`,
    `    args: ["${STUB_CLI.replaceAll("\\", "\\\\")}", "echo", "{prompt}"]`,
    "    outputFormat: json",
    "    tags: [\"code-review\"]",
    "  claude-code:",
    `    command: "${process.execPath.replaceAll("\\", "\\\\")}"`,
    `    args: ["${STUB_CLI.replaceAll("\\", "\\\\")}", "fail", "{prompt}"]`,
  ].join("\n");
  writeFileSync(agentBridgePath(homeDir), yaml);
}

function text(value: { content?: Array<{ type: string; text?: string }> }): string {
  return value.content?.find((item) => item.type === "text")?.text ?? "";
}

test("AgentBridgeProvider: lists one tool per configured target, excluding the caller itself", () => {
  const homeDir = home();
  writeConfig(homeDir);
  const provider = new AgentBridgeProvider();

  const asClaudeCode = provider.listTools({ agentId: "claude-code", homeDir });
  const names = asClaudeCode.map((tool) => tool.name);
  assert.ok(names.includes("trellis.agent_bridge.run_codex"));
  assert.ok(!names.includes("trellis.agent_bridge.run_claude_code"), "must not offer to delegate to itself");
  assert.match(asClaudeCode.find((tool) => tool.name === "trellis.agent_bridge.run_codex")!.description ?? "", /code-review/);
});

test("AgentBridgeProvider: no configured targets means no tools, not an error", () => {
  const provider = new AgentBridgeProvider();
  const tools = provider.listTools({ agentId: "claude-code", homeDir: home() });
  assert.deepEqual(tools, []);
});

test("AgentBridgeProvider: rejects a call without confirm=true, spawning nothing", async () => {
  const homeDir = home();
  writeConfig(homeDir);
  const provider = new AgentBridgeProvider();
  const context: RuntimeContext = { agentId: "claude-code", homeDir };
  provider.listTools(context);

  const rejected = await provider.callTool("trellis.agent_bridge.run_codex", { prompt: "hi", confirm: false }, context);
  assert.equal(rejected.isError, true);
  assert.match(text(rejected), /confirm=true/);
});

test("AgentBridgeProvider: confirmed call delegates to the target and returns its result", async () => {
  const homeDir = home();
  writeConfig(homeDir);
  const provider = new AgentBridgeProvider();
  const context: RuntimeContext = { agentId: "claude-code", homeDir };
  provider.listTools(context);

  const outcome = await provider.callTool("trellis.agent_bridge.run_codex", { prompt: "hi", confirm: true }, context);
  const parsed = JSON.parse(text(outcome));
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.output, "echo:hi");
  assert.equal(parsed.targetAgent, "codex");
});

test("AgentBridgeProvider: a failing target reports failed, not a thrown error", async () => {
  const homeDir = home();
  writeConfig(homeDir);
  const provider = new AgentBridgeProvider();
  const context: RuntimeContext = { agentId: "codex", homeDir };
  provider.listTools(context);

  const outcome = await provider.callTool("trellis.agent_bridge.run_claude_code", { prompt: "hi", confirm: true }, context);
  const parsed = JSON.parse(text(outcome));
  assert.equal(parsed.status, "failed");
});

test("AgentBridgeProvider: ZCode delegation refuses before spawning without a compatible public CLI", async () => {
  const homeDir = home();
  mkdirSync(join(homeDir, ".trellis", "mcp"), { recursive: true });
  writeFileSync(agentBridgePath(homeDir), ["targets:", "  zcode:", "    command: zcode", '    args: ["--prompt", "{prompt}", "--output-format", "json"]', "    outputFormat: json"].join("\n"));
  const previous = process.env.TRELLIS_ZCODE_BIN;
  process.env.TRELLIS_ZCODE_BIN = join(homeDir, "missing-zcode");
  try {
    const provider = new AgentBridgeProvider();
    const context: RuntimeContext = { agentId: "claude-code", homeDir };
    provider.listTools(context);
    const outcome = await provider.callTool("trellis.agent_bridge.run_zcode", { prompt: "hi", confirm: true }, context);
    assert.equal(outcome.isError, true);
    assert.match(text(outcome), /compatible public zcode CLI/);
  } finally {
    if (previous === undefined) delete process.env.TRELLIS_ZCODE_BIN;
    else process.env.TRELLIS_ZCODE_BIN = previous;
  }
});

async function withDepthEnv<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[DELEGATION_DEPTH_ENV];
  process.env[DELEGATION_DEPTH_ENV] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[DELEGATION_DEPTH_ENV];
    else process.env[DELEGATION_DEPTH_ENV] = previous;
  }
}

test("AgentBridgeProvider: refuses a call at the delegation depth limit, spawning nothing", async () => {
  const homeDir = home();
  writeConfig(homeDir); // default maxDepth (2)
  const provider = new AgentBridgeProvider();
  const context: RuntimeContext = { agentId: "claude-code", homeDir };
  provider.listTools(context);

  await withDepthEnv("2", async () => {
    const outcome = await provider.callTool("trellis.agent_bridge.run_codex", { prompt: "hi", confirm: true }, context);
    assert.equal(outcome.isError, true);
    assert.match(text(outcome), /delegation depth limit reached/);
  });
});

test("AgentBridgeProvider: a call below the depth limit proceeds and increments depth for the child", async () => {
  const homeDir = home();
  mkdirSync(join(homeDir, ".trellis", "mcp"), { recursive: true });
  writeFileSync(
    agentBridgePath(homeDir),
    ["targets:", "  codex:", `    command: "${process.execPath.replaceAll("\\", "\\\\")}"`, `    args: ["${STUB_CLI.replaceAll("\\", "\\\\")}", "env"]`, "    outputFormat: json"].join("\n"),
  );
  const provider = new AgentBridgeProvider();
  const context: RuntimeContext = { agentId: "claude-code", homeDir };
  provider.listTools(context);

  await withDepthEnv("1", async () => {
    const outcome = await provider.callTool("trellis.agent_bridge.run_codex", { prompt: "hi", confirm: true }, context);
    const parsed = JSON.parse(text(outcome));
    assert.equal(parsed.status, "completed");
    assert.equal(parsed.output, "2", "the child must see depth (1) + 1");
  });
});

test("AgentBridgeProvider: threads a call-level persona and a resumed sessionId into the delegated invocation", async () => {
  const homeDir = home();
  mkdirSync(join(homeDir, ".trellis", "mcp"), { recursive: true });
  writeFileSync(
    agentBridgePath(homeDir),
    [
      "targets:",
      "  codex:",
      `    command: "${process.execPath.replaceAll("\\", "\\\\")}"`,
      `    args: ["${STUB_CLI.replaceAll("\\", "\\\\")}", "echo", "--persona", "{persona}", "{prompt}"]`,
      `    resumeArgs: ["${STUB_CLI.replaceAll("\\", "\\\\")}", "echo", "--resume", "{sessionId}", "{prompt}"]`,
      "    outputFormat: json",
    ].join("\n"),
  );
  const provider = new AgentBridgeProvider();
  const context: RuntimeContext = { agentId: "claude-code", homeDir };
  provider.listTools(context);

  const fresh = await provider.callTool("trellis.agent_bridge.run_codex", { prompt: "hi", persona: "a terse reviewer", confirm: true }, context);
  assert.match(text(fresh), /a terse reviewer/);

  const resumed = await provider.callTool("trellis.agent_bridge.run_codex", { prompt: "continue", sessionId: "abc-123", confirm: true }, context);
  const parsedResumed = JSON.parse(text(resumed));
  assert.equal(parsedResumed.output, "echo:--resume|abc-123|continue");
});
