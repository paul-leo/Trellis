#!/usr/bin/env node
/**
 * Steady-state unified-management acceptance lab. Unlike migration-lab, the
 * canonical source already exists and every agent has user-owned content.
 * The lab checks convergence, idempotency, ownership boundaries and safe
 * lifecycle removal across skills, MCP, memory and runtime delivery.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";

const labHome = process.env.HOME;
assert.ok(labHome, "sandbox HOME must be set");

function runJson(args) {
  try {
    const stdout = execFileSync("trellis", args, { encoding: "utf8", env: { ...process.env, HOME: labHome } });
    return { code: 0, value: JSON.parse(stdout) };
  } catch (error) {
    return { code: Number(error.status ?? 1), value: JSON.parse(String(error.stdout ?? "")) };
  }
}

function read(path) {
  return readFileSync(path, "utf8");
}

function isSymlink(path) {
  return existsSync(path) && lstatSync(path).isSymbolicLink();
}

const claudeConfigBefore = JSON.parse(read(`${labHome}/.claude.json`));
const kiroConfigBefore = JSON.parse(read(`${labHome}/.kiro/settings/mcp.json`));
const piConfigBefore = read(`${labHome}/.pi/agent/settings.json`);

console.log("[management-lab] converge native skills and managed extensions");
const firstSync = runJson(["sync", "--json"]);
assert.equal(firstSync.code, 1, "the pre-existing Kiro instruction file must remain a visible conflict");
assert.ok(isSymlink(`${labHome}/.claude/skills/shared-skill`));
assert.ok(isSymlink(`${labHome}/.claude/skills/claude-skill`));
assert.ok(isSymlink(`${labHome}/.kiro/skills/shared-skill`));
assert.ok(isSymlink(`${labHome}/.kiro/skills/kiro-skill`));
assert.ok(isSymlink(`${labHome}/.pi/agent/extensions/trellis-mcp-bridge.js`));
assert.ok(!existsSync(`${labHome}/.codex/skills/shared-skill`), "Codex mcp delivery must not create a native skill projection");

console.log("[management-lab] converge each agent MCP route and delivery mode");
const firstMcp = runJson(["mcp", "sync", "--json"]);
assert.equal(firstMcp.code, 0);
const firstReports = new Map(firstMcp.value.reports.map((report) => [report.agent, report]));
assert.ok(firstReports.get("claude-code").items.some((item) => item.mcpWrite?.name === "shared-tool"));
assert.ok(firstReports.get("codex").items.some((item) => item.mcpWrite?.name === "trellis-runtime"));
assert.ok(firstReports.get("kiro").items.some((item) => item.mcpWrite?.name === "trellis-runtime"));
assert.equal(firstReports.get("pi").items.length, 0, "pi consumes MCP through its bridge extension");

const claudeConfig = JSON.parse(read(`${labHome}/.claude.json`));
const kiroConfig = JSON.parse(read(`${labHome}/.kiro/settings/mcp.json`));
assert.equal(claudeConfig.customSetting, claudeConfigBefore.customSetting);
assert.deepEqual(claudeConfig.mcpServers["user-claude"], claudeConfigBefore.mcpServers["user-claude"]);
assert.equal(kiroConfig.customSetting, kiroConfigBefore.customSetting);
assert.deepEqual(kiroConfig.mcpServers["user-kiro"], kiroConfigBefore.mcpServers["user-kiro"]);
assert.equal(read(`${labHome}/.pi/agent/settings.json`), piConfigBefore);

console.log("[management-lab] synchronize canonical memory");
const firstMemory = runJson(["memory", "sync", "--json"]);
assert.equal(firstMemory.code, 0);
assert.ok(existsSync(`${labHome}/.trellis/memories/graph.jsonl`));

console.log("[management-lab] rerun all managers and require idempotency");
const secondSync = runJson(["sync", "--json"]);
assert.equal(secondSync.code, 1, "the deliberate Kiro instruction conflict remains, but no managed writes regress");
const secondMcp = runJson(["mcp", "sync", "--json"]);
assert.equal(secondMcp.code, 0);
assert.ok(secondMcp.value.reports.every((report) => report.items.length === 0));
const secondMemory = runJson(["memory", "sync", "--json"]);
assert.equal(secondMemory.code, 0);
assert.ok(secondMemory.value.plan.items.every((item) => item.action === "already-synced"));

console.log("[management-lab] remove canonical capabilities and verify owned cleanup");
assert.equal(runJson(["skill", "remove", "retired-skill", "--json"]).code, 0);
runJson(["sync", "--json"]);
assert.ok(!existsSync(`${labHome}/.claude/skills/retired-skill`));
assert.ok(!existsSync(`${labHome}/.kiro/skills/retired-skill`));

assert.equal(runJson(["mcp", "remove", "retired-mcp", "--json"]).code, 0);
assert.equal(runJson(["mcp", "sync", "--json"]).code, 0);
const afterMcpRemoval = JSON.parse(read(`${labHome}/.claude.json`));
assert.equal(afterMcpRemoval.mcpServers["retired-mcp"], undefined);
assert.deepEqual(afterMcpRemoval.mcpServers["user-claude"], claudeConfigBefore.mcpServers["user-claude"]);

console.log("[management-lab] verify final drift and secret health");
const doctor = runJson(["doctor", "--json"]);
assert.equal(doctor.code, 0, JSON.stringify(doctor.value));
assert.deepEqual(doctor.value.findings, []);
const audit = runJson(["secrets", "audit", "--json"]);
assert.equal(audit.code, 0, JSON.stringify(audit.value));
assert.deepEqual(audit.value.findings, []);

console.log("[management-lab] PASS: unified multi-agent management, idempotency and lifecycle");
