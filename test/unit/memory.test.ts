/**
 * trellis-memory-sync: `trellis memory sync` end-to-end against a
 * scratch $HOME.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectMemorySyncResult, runMemorySync } from "../../src/commands/memory.js";
import { TRELLIS_MEMORY_ENTITY_TYPE } from "../../src/lib/memoryGraph.js";

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "trellis-memory-cmd-"));
}

function initCanonical(home: string, serversYaml: string): void {
  mkdirSync(join(home, ".trellis", "memories"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(join(home, ".trellis", "managed.yaml"), "agents: []\n");
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), serversYaml);
}

test("no 'memory' server configured — reports cleanly, not an error", () => {
  const home = scratchHome();
  initCanonical(home, "servers: {}\n");

  const result = collectMemorySyncResult(home);
  assert.equal(result.configured, false);
  const { exitCode } = runMemorySync({ homeDir: home });
  assert.equal(exitCode, 0);
});

test("a 'memory' server without MEMORY_FILE_PATH is treated the same as unconfigured", () => {
  const home = scratchHome();
  initCanonical(home, 'servers:\n  memory:\n    transport: stdio\n    command: npx\n    args: ["-y", "@modelcontextprotocol/server-memory"]\n');

  const result = collectMemorySyncResult(home);
  assert.equal(result.configured, false);
});

test("a real memory file is ingested into the configured graph path", () => {
  const home = scratchHome();
  const graphPath = join(home, "graph.jsonl");
  initCanonical(
    home,
    `servers:\n  memory:\n    transport: stdio\n    command: npx\n    args: ["-y", "@modelcontextprotocol/server-memory"]\n    static_env:\n      MEMORY_FILE_PATH: "${graphPath}"\n`,
  );
  writeFileSync(join(home, ".trellis", "memories", "notes.md"), "# Notes\nreal content\n");

  const { exitCode } = runMemorySync({ homeDir: home });
  assert.equal(exitCode, 0);
  assert.ok(existsSync(graphPath));
  const written = JSON.parse(readFileSync(graphPath, "utf-8").trim());
  assert.deepEqual(written, { type: "entity", name: "notes", entityType: TRELLIS_MEMORY_ENTITY_TYPE, observations: ["# Notes\nreal content\n"] });
});

test("--dry-run computes the plan but writes nothing", () => {
  const home = scratchHome();
  const graphPath = join(home, "graph.jsonl");
  initCanonical(
    home,
    `servers:\n  memory:\n    transport: stdio\n    command: npx\n    static_env:\n      MEMORY_FILE_PATH: "${graphPath}"\n`,
  );
  writeFileSync(join(home, ".trellis", "memories", "notes.md"), "content\n");

  const { exitCode } = runMemorySync({ homeDir: home, dryRun: true });
  assert.equal(exitCode, 0);
  assert.ok(!existsSync(graphPath), "dry-run must not write the graph file");
});

test("a removed memory file removes its entity from the graph on the next sync, leaving other content untouched", () => {
  const home = scratchHome();
  const graphPath = join(home, "graph.jsonl");
  initCanonical(
    home,
    `servers:\n  memory:\n    transport: stdio\n    command: npx\n    static_env:\n      MEMORY_FILE_PATH: "${graphPath}"\n`,
  );
  writeFileSync(join(home, ".trellis", "memories", "notes.md"), "content\n");
  runMemorySync({ homeDir: home });
  assert.ok(existsSync(graphPath));

  // An agent adds its own, unrelated runtime-created entity directly.
  const current = readFileSync(graphPath, "utf-8");
  writeFileSync(graphPath, `${current}${JSON.stringify({ type: "entity", name: "runtime-thing", entityType: "person", observations: ["hi"] })}\n`);

  // The canonical memory is deleted.
  rmSync(join(home, ".trellis", "memories", "notes.md"));

  const { exitCode } = runMemorySync({ homeDir: home });
  assert.equal(exitCode, 0);
  const finalLines = readFileSync(graphPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(!finalLines.some((l) => l.name === "notes"), "the removed memory's entity must be gone");
  assert.ok(finalLines.some((l) => l.name === "runtime-thing"), "the agent's own runtime entity must survive untouched");
});

test("a name colliding with a non-trellis-memory entity refuses (conflict), exit code 1", () => {
  const home = scratchHome();
  const graphPath = join(home, "graph.jsonl");
  writeFileSync(graphPath, `${JSON.stringify({ type: "entity", name: "notes", entityType: "person", observations: ["not ours"] })}\n`);
  initCanonical(
    home,
    `servers:\n  memory:\n    transport: stdio\n    command: npx\n    static_env:\n      MEMORY_FILE_PATH: "${graphPath}"\n`,
  );
  writeFileSync(join(home, ".trellis", "memories", "notes.md"), "canonical content\n");

  const { exitCode } = runMemorySync({ homeDir: home });
  assert.equal(exitCode, 1);
  const untouched = readFileSync(graphPath, "utf-8");
  assert.ok(untouched.includes("not ours"), "the pre-existing entity must survive untouched");
});
