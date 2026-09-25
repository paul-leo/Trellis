import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chatAgentsPath, loadChatAgentConfig } from "../../src/lib/chatAgents.js";

function home(): string { return mkdtempSync(join(tmpdir(), "trellis-chat-agents-")); }

function writeConfig(homeDir: string, yaml: string): void {
  const path = chatAgentsPath(homeDir);
  mkdirSync(join(homeDir, ".trellis", "mcp"), { recursive: true });
  writeFileSync(path, yaml);
}

test("loadChatAgentConfig: absent file means zero targets, not an error", () => {
  const config = loadChatAgentConfig(home());
  assert.deepEqual(config.targets, {});
});

test("loadChatAgentConfig: parses a valid target with an arbitrary (non-AgentId) key", () => {
  const homeDir = home();
  writeConfig(
    homeDir,
    `targets:\n  qoder:\n    label: "Qoder"\n    command: qoder\n    args: ["-p", "{prompt}", "--output-format", "stream-json"]\n    outputFormat: stream-json\n    tags: ["domestic"]\n`,
  );
  const config = loadChatAgentConfig(homeDir);
  assert.deepEqual(config.targets.qoder, {
    label: "Qoder",
    command: "qoder",
    args: ["-p", "{prompt}", "--output-format", "stream-json"],
    outputFormat: "stream-json",
    tags: ["domestic"],
  });
});

test("loadChatAgentConfig: accepts a key that is also a real AgentId", () => {
  const homeDir = home();
  writeConfig(homeDir, `targets:\n  codex:\n    label: "Codex"\n    command: codex\n    args: ["exec", "{prompt}"]\n`);
  const config = loadChatAgentConfig(homeDir);
  assert.equal(config.targets.codex?.label, "Codex");
});

test("loadChatAgentConfig: rejects a target missing label", () => {
  const homeDir = home();
  writeConfig(homeDir, `targets:\n  qoder:\n    command: qoder\n    args: ["{prompt}"]\n`);
  assert.throws(() => loadChatAgentConfig(homeDir), /must declare a non-empty "label"/);
});

test("loadChatAgentConfig: rejects a target missing command/args", () => {
  const homeDir = home();
  writeConfig(homeDir, `targets:\n  qoder:\n    label: "Qoder"\n    command: qoder\n`);
  assert.throws(() => loadChatAgentConfig(homeDir), /must declare "command" and a non-empty "args"/);
});

test("loadChatAgentConfig: rejects an unknown outputFormat", () => {
  const homeDir = home();
  writeConfig(homeDir, `targets:\n  qoder:\n    label: "Qoder"\n    command: qoder\n    args: ["{prompt}"]\n    outputFormat: xml\n`);
  assert.throws(() => loadChatAgentConfig(homeDir), /unknown outputFormat/);
});

test("loadChatAgentConfig: rejects an empty resumeArgs", () => {
  const homeDir = home();
  writeConfig(homeDir, `targets:\n  qoder:\n    label: "Qoder"\n    command: qoder\n    args: ["{prompt}"]\n    resumeArgs: []\n`);
  assert.throws(() => loadChatAgentConfig(homeDir), /invalid "resumeArgs"/);
});

test("loadChatAgentConfig: parses resumeArgs and persona", () => {
  const homeDir = home();
  writeConfig(
    homeDir,
    `targets:\n  qoder:\n    label: "Qoder"\n    command: qoder\n    args: ["-p", "{prompt}"]\n    resumeArgs: ["-p", "{prompt}", "--resume", "{sessionId}"]\n    persona: "a terse reviewer"\n`,
  );
  const config = loadChatAgentConfig(homeDir);
  assert.deepEqual(config.targets.qoder?.resumeArgs, ["-p", "{prompt}", "--resume", "{sessionId}"]);
  assert.equal(config.targets.qoder?.persona, "a terse reviewer");
});

test("loadChatAgentConfig: parses the ZCode stream protocol", () => {
  const homeDir = home();
  writeConfig(homeDir, `targets:\n  zcode:\n    label: "ZCode"\n    command: zcode\n    args: ["--prompt", "{prompt}", "--output-format", "stream-json"]\n    outputFormat: stream-json\n    streamProtocol: zcode\n`);
  assert.equal(loadChatAgentConfig(homeDir).targets.zcode?.streamProtocol, "zcode");
});

test("docs/getting-started.md's chat-agents.yaml starter block actually parses — catches doc/code drift", () => {
  const docsPath = join(process.cwd(), "docs/getting-started.md");
  const docs = readFileSync(docsPath, "utf-8");
  const match = /```yaml\ntargets:\n(?:.*\n)*?```/.exec(docs);
  assert.ok(match, "expected a fenced ```yaml targets: ...``` block in docs/getting-started.md's Chat section");
  const yaml = match![0].replace(/^```yaml\n/, "").replace(/```$/, "");

  const homeDir = home();
  writeConfig(homeDir, yaml);
  const config = loadChatAgentConfig(homeDir);

  const expectedIds = ["claude-code", "qoder", "kimi-code", "minimax-code", "zcode"];
  assert.deepEqual(Object.keys(config.targets).sort(), expectedIds.sort());
  for (const id of expectedIds) {
    const target = config.targets[id];
    assert.ok(target?.label, `${id} must have a label`);
    assert.ok(target?.command, `${id} must have a command`);
    assert.ok(target?.args.includes("{prompt}"), `${id}'s args must reference {prompt}`);
  }
  // All three domestic targets have a real, `--help`-confirmed resume flag
  // (Qoder's `--session-id`, Kimi Code's `-S`, MiniMax Code's `--session`)
  // and reference {sessionId} in their resumeArgs.
  assert.ok(config.targets.qoder?.resumeArgs?.includes("{sessionId}"));
  assert.ok(config.targets["kimi-code"]?.resumeArgs?.includes("{sessionId}"));
  assert.ok(config.targets["minimax-code"]?.resumeArgs?.includes("{sessionId}"));
  assert.ok(config.targets.zcode?.resumeArgs?.includes("{sessionId}"));
  assert.equal(config.targets.zcode?.streamProtocol, "zcode");
});
