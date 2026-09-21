#!/usr/bin/env node
/**
 * Real-CLI proof for trellis-agent-bridge: calls `runDelegatedCall`
 * directly (the exact function AgentBridgeProvider uses) against a real,
 * installed Agent binary inside the isolated agent-sandbox container, with
 * only that one Agent's host auth file bridged in read-only
 * (scripts/agent-sandbox.sh --host-auth). Not a Trellis config test — no
 * agent-bridge.yaml, no gateway process — purely: does a real one-shot
 * headless delegated call actually round-trip against a real backend.
 */
import assert from "node:assert/strict";
import { runDelegatedCall } from "../dist/lib/agentBridge.js";

const TARGETS = {
  codex: { command: "codex", args: ["exec", "--skip-git-repo-check", "{prompt}"], outputFormat: "text", timeoutMs: 120_000 },
  pi: { command: "pi", args: ["--print", "--mode", "text", "{prompt}"], outputFormat: "text", timeoutMs: 120_000 },
  "claude-code": { command: "claude", args: ["-p", "--output-format", "json", "{prompt}"], outputFormat: "json", timeoutMs: 120_000 },
  "kimi-code": { command: "kimi", args: ["-p", "{prompt}", "--output-format", "text", "-m", "kimi-code/k3"], outputFormat: "text", timeoutMs: 120_000 },
};

const agent = process.argv[2];
const target = TARGETS[agent];
if (!target) {
  console.error(`usage: agent-bridge-smoke.mjs <${Object.keys(TARGETS).join("|")}>`);
  process.exit(2);
}

console.log(`[agent-bridge-smoke] delegating one real prompt to real "${agent}"`);
const outcome = await runDelegatedCall(agent, target, "Reply with exactly the single word PONG and nothing else. Do not use any tools.");
console.log(JSON.stringify(outcome, null, 2));
assert.equal(outcome.status, "completed", `expected completed, got ${outcome.status}: ${outcome.output}`);
assert.match(outcome.output, /PONG/i, `expected PONG in the real response, got: ${outcome.output}`);
console.log(`[agent-bridge-smoke] PASS: real "${agent}" delegated call round-tripped`);
