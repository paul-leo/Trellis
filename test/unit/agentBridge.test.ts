import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentBridgePath, loadAgentBridgeConfig, readDelegationDepth, runDelegatedCall } from "../../src/lib/agentBridge.js";

const STUB_CLI = join(process.cwd(), "test/fixtures/stub-agent-cli.js");

function home(): string { return mkdtempSync(join(tmpdir(), "trellis-agent-bridge-")); }

function writeConfig(homeDir: string, yaml: string): void {
  const path = agentBridgePath(homeDir);
  mkdirSync(join(homeDir, ".trellis", "mcp"), { recursive: true });
  writeFileSync(path, yaml);
}

test("loadAgentBridgeConfig: absent file means zero targets, not an error", () => {
  const config = loadAgentBridgeConfig(home());
  assert.deepEqual(config.targets, {});
});

test("loadAgentBridgeConfig: parses a valid target", () => {
  const homeDir = home();
  writeConfig(homeDir, `targets:\n  codex:\n    command: codex\n    args: ["exec", "{prompt}"]\n    outputFormat: text\n    tags: ["code-review"]\n`);
  const config = loadAgentBridgeConfig(homeDir);
  assert.deepEqual(config.targets.codex, { command: "codex", args: ["exec", "{prompt}"], outputFormat: "text", tags: ["code-review"] });
});

test("loadAgentBridgeConfig: rejects an unknown Agent id", () => {
  const homeDir = home();
  writeConfig(homeDir, `targets:\n  not-a-real-agent:\n    command: foo\n    args: ["{prompt}"]\n`);
  assert.throws(() => loadAgentBridgeConfig(homeDir), /not a supported Agent id/);
});

test("loadAgentBridgeConfig: rejects a target missing command/args", () => {
  const homeDir = home();
  writeConfig(homeDir, `targets:\n  codex:\n    command: codex\n`);
  assert.throws(() => loadAgentBridgeConfig(homeDir), /must declare "command" and a non-empty "args"/);
});

test("loadAgentBridgeConfig: rejects an unknown outputFormat", () => {
  const homeDir = home();
  writeConfig(homeDir, `targets:\n  codex:\n    command: codex\n    args: ["{prompt}"]\n    outputFormat: xml\n`);
  assert.throws(() => loadAgentBridgeConfig(homeDir), /unknown outputFormat/);
});

test("runDelegatedCall: completed call extracts text from json output", async () => {
  const outcome = await runDelegatedCall("codex", { command: process.execPath, args: [STUB_CLI, "echo", "{prompt}"], outputFormat: "json" }, "hello");
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.output, "echo:hello");
  assert.equal(outcome.targetAgent, "codex");
  assert.equal(typeof outcome.durationMs, "number");
});

test("runDelegatedCall: non-zero exit is reported as failed with stderr", async () => {
  const outcome = await runDelegatedCall("codex", { command: process.execPath, args: [STUB_CLI, "fail", "{prompt}"] }, "hello");
  assert.equal(outcome.status, "failed");
  assert.match(outcome.output, /failing as requested/);
});

test("runDelegatedCall: a hanging process is killed and reported as timeout", async () => {
  const outcome = await runDelegatedCall("codex", { command: process.execPath, args: [STUB_CLI, "hang", "{prompt}"] }, "hello", { timeoutMs: 200 });
  assert.equal(outcome.status, "timeout");
});

test("loadAgentBridgeConfig: parses maxDepth, resumeArgs, and persona", () => {
  const homeDir = home();
  writeConfig(
    homeDir,
    `maxDepth: 3\ntargets:\n  codex:\n    command: codex\n    args: ["exec", "{prompt}"]\n    resumeArgs: ["exec", "resume", "{sessionId}", "{prompt}"]\n    persona: "a terse senior reviewer"\n`,
  );
  const config = loadAgentBridgeConfig(homeDir);
  assert.equal(config.maxDepth, 3);
  assert.deepEqual(config.targets.codex?.resumeArgs, ["exec", "resume", "{sessionId}", "{prompt}"]);
  assert.equal(config.targets.codex?.persona, "a terse senior reviewer");
});

test("loadAgentBridgeConfig: rejects a non-positive-integer maxDepth", () => {
  const homeDir = home();
  writeConfig(homeDir, `maxDepth: 0\ntargets:\n  codex:\n    command: codex\n    args: ["{prompt}"]\n`);
  assert.throws(() => loadAgentBridgeConfig(homeDir), /"maxDepth" must be a positive integer/);
});

test("loadAgentBridgeConfig: rejects an empty resumeArgs", () => {
  const homeDir = home();
  writeConfig(homeDir, `targets:\n  codex:\n    command: codex\n    args: ["{prompt}"]\n    resumeArgs: []\n`);
  assert.throws(() => loadAgentBridgeConfig(homeDir), /invalid "resumeArgs"/);
});

test("readDelegationDepth: absent, malformed, and valid env values", () => {
  assert.equal(readDelegationDepth({}), 0);
  assert.equal(readDelegationDepth({ TRELLIS_DELEGATION_DEPTH: "not-a-number" }), 0);
  assert.equal(readDelegationDepth({ TRELLIS_DELEGATION_DEPTH: "-1" }), 0);
  assert.equal(readDelegationDepth({ TRELLIS_DELEGATION_DEPTH: "2" }), 2);
});

test("runDelegatedCall: propagates depth + 1 to the child's environment", async () => {
  const outcome = await runDelegatedCall("codex", { command: process.execPath, args: [STUB_CLI, "env"], outputFormat: "json" }, "hello", { depth: 1 });
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.output, "2");
});

test("runDelegatedCall: a target with no persona slot gets the prompt prefixed", async () => {
  const outcome = await runDelegatedCall("codex", { command: process.execPath, args: [STUB_CLI, "echo", "{prompt}"], outputFormat: "json" }, "review this", { persona: "a terse senior reviewer" });
  assert.equal(outcome.output, "echo:[Persona: a terse senior reviewer]\n\nreview this");
});

test("runDelegatedCall: a target with a {persona} slot keeps the prompt untouched", async () => {
  const outcome = await runDelegatedCall("codex", { command: process.execPath, args: [STUB_CLI, "echo", "--persona", "{persona}", "{prompt}"], outputFormat: "json" }, "review this", { persona: "a terse senior reviewer" });
  assert.equal(outcome.output, "echo:--persona|a terse senior reviewer|review this");
});

test("runDelegatedCall: a call-level persona overrides the target's default", async () => {
  const outcome = await runDelegatedCall("codex", { command: process.execPath, args: [STUB_CLI, "echo", "{prompt}"], outputFormat: "json", persona: "default persona" }, "hi", { persona: "override persona" });
  assert.match(outcome.output, /override persona/);
  assert.doesNotMatch(outcome.output, /default persona/);
});

test("runDelegatedCall: extracts a sessionId from json output", async () => {
  const outcome = await runDelegatedCall("codex", { command: process.execPath, args: [STUB_CLI, "echo", "{prompt}"], outputFormat: "json" }, "hi");
  assert.equal(outcome.sessionId, "stub-session-123");
});

test("runDelegatedCall: resuming uses resumeArgs and threads the sessionId through", async () => {
  const outcome = await runDelegatedCall(
    "codex",
    { command: process.execPath, args: [STUB_CLI, "echo", "{prompt}"], resumeArgs: [STUB_CLI, "echo", "--resume", "{sessionId}", "{prompt}"], outputFormat: "json" },
    "continue please",
    { sessionId: "stub-session-123" },
  );
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.output, "echo:--resume|stub-session-123|continue please");
});

test("runDelegatedCall: resuming against a target with no resumeArgs fails clearly, without spawning", async () => {
  const outcome = await runDelegatedCall("codex", { command: process.execPath, args: [STUB_CLI, "echo", "{prompt}"] }, "continue please", { sessionId: "stub-session-123" });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.output, /no resumeArgs configured/);
});
