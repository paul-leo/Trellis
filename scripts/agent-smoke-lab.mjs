#!/usr/bin/env node
/**
 * Real agent CLI smoke lab. No credentials are supplied: it proves the
 * installed binaries parse their own isolated HOME and recognize Trellis's
 * generated MCP configuration. Model-session tool invocation is deliberately
 * deferred until a sandbox-safe login/token flow is chosen.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const labHome = process.env.HOME;
assert.ok(labHome, "sandbox HOME must be set");
const agentEnv = { ...process.env, HOME: labHome, KIRO_HOME: labHome + "/.kiro" };

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", env: agentEnv, stdio: ["ignore", "pipe", "pipe"] });
}

function runResult(command, args) {
  try {
    return { status: 0, stdout: run(command, args), stderr: "" };
  } catch (error) {
    return { status: Number(error.status ?? 1), stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

console.log("[agent-smoke] prepare runtime-home through Trellis itself");
run("node", ["scripts/runtime-lab.mjs"]);

console.log("[agent-smoke] verify real Codex installation and generated MCP entry");
assert.match(run("codex", ["--version"]), /\S/);
const codexMcp = JSON.parse(run("codex", ["mcp", "list", "--json"]));
assert.ok(codexMcp.some((entry) => entry.name === "trellis-runtime"), "real Codex must list the Trellis runtime entry from its own config");

console.log("[agent-smoke] verify real Claude Code installation and generated MCP entry");
assert.match(run("claude", ["--version"]), /\S/);
const claudeMcp = run("claude", ["mcp", "list"]);
assert.match(claudeMcp, /trellis-runtime/);

console.log("[agent-smoke] verify real Kiro CLI installation and generated MCP entries");
assert.ok(run("kiro-cli", ["--version"]).trim().length > 0);
const kiroConfig = readFileSync(labHome + "/.kiro/settings/mcp.json", "utf8");
assert.match(kiroConfig, /shared-tool/);
assert.match(kiroConfig, /kiro-private-tool/);
const kiroMcp = runResult("kiro-cli", ["mcp", "list"]);
assert.equal(kiroMcp.status, 1);
assert.match(kiroMcp.stderr, /not logged in/i);

console.log("[agent-smoke] verify real pi installation and managed bridge projection");
run("pi", ["--version"]);

console.log("[agent-smoke] PASS: real Codex and Claude recognize Runtime config; real Kiro correctly gates MCP listing on login; real pi is executable");
