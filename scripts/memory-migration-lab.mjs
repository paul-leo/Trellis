#!/usr/bin/env node
/** Isolated source-memory migration acceptance lab. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const home = process.env.HOME;
assert.ok(home);

function runJson(args) {
  try {
    const stdout = execFileSync("trellis", args, { encoding: "utf8", env: { ...process.env, HOME: home } });
    return { code: 0, value: JSON.parse(stdout) };
  } catch (error) {
    return { code: Number(error.status ?? 1), value: JSON.parse(String(error.stdout ?? "{}")) };
  }
}

console.log("[memory-migration-lab] import supported Claude project memory");
const first = runJson(["onboard", "--agent", "claude-code", "--manage", "none", "--memory-migrate", "on", "--memory", "off", "--json"]);
assert.equal(first.code, 0, JSON.stringify(first.value));
assert.equal(first.value.migratePlan.memoryDiscovery.status, "supported");
assert.ok(first.value.migratePlan.items.some((item) => item.kind === "memory" && item.action === "create"));
const target = join(home, ".trellis", "memories", "claude-trellis-memory.md");
assert.ok(existsSync(target));
assert.match(readFileSync(target, "utf8"), /Claude durable memory/);

console.log("[memory-migration-lab] repeat is idempotent and conflicts are protected");
const second = runJson(["migrate", "--from", "claude-code", "--only", "memory", "--json"]);
assert.equal(second.code, 0, JSON.stringify(second.value));
assert.ok(second.value.items.some((item) => item.kind === "memory" && item.action === "already-migrated"));
const source = join(home, ".claude", "projects", "-trellis", "memory", "MEMORY.md");
writeFileSync(source, "# changed source memory\n");
const conflict = runJson(["migrate", "--from", "claude-code", "--only", "memory", "--dry-run", "--json"]);
assert.equal(conflict.code, 1);
assert.ok(conflict.value.items.some((item) => item.kind === "memory" && item.action === "conflict"));
assert.match(readFileSync(target, "utf8"), /Claude durable memory/);

console.log("[memory-migration-lab] import Codex local Memory independently");
const codex = runJson(["migrate", "--from", "codex", "--only", "memory", "--json"]);
assert.equal(codex.code, 0, JSON.stringify(codex.value));
assert.ok(codex.value.items.some((item) => item.kind === "memory" && item.action === "create"));
const codexTarget = join(home, ".trellis", "memories", "codex-persistent.md");
assert.ok(existsSync(codexTarget));
assert.match(readFileSync(codexTarget, "utf8"), /Codex persistent memory/);
assert.match(readFileSync(join(home, ".codex", "session_index.jsonl"), "utf8"), /must not import/);
assert.match(readFileSync(join(home, ".codex", "sessions", "transcript.jsonl"), "utf8"), /must not import/);

console.log("[memory-migration-lab] Kimi/pi session stores remain unsupported and untouched");
const unsupported = runJson(["onboard", "--agent", "kimi-code", "--manage", "none", "--memory-migrate", "on", "--memory", "off", "--json"]);
assert.equal(unsupported.code, 0, JSON.stringify(unsupported.value));
const kimi = unsupported.value.summary.find((item) => item.agent === "kimi-code");
assert.equal(kimi.nativeMemoryStatus, "unsupported");
assert.equal(unsupported.value.migratePlan, undefined);
assert.match(readFileSync(join(home, ".kimi-code", "sessions", "session.jsonl"), "utf8"), /must not be imported/);
assert.match(readFileSync(join(home, ".pi", "agent", "sessions", "session.jsonl"), "utf8"), /must not be imported/);

console.log("[memory-migration-lab] PASS: independent memory migration choice and shared-backend boundary");
