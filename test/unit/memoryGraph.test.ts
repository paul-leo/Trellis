/**
 * trellis-memory-sync: `planMemorySync`/`parseMemoryGraph`/
 * `renderMemoryGraph` — pure logic, no filesystem access, matching
 * `parseMemoryGraph`'s own tolerant-of-bad-lines contract.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMemoryGraph, planMemorySync, renderMemoryGraph, TRELLIS_MEMORY_ENTITY_TYPE } from "../../src/lib/memoryGraph.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function memoryFile(dir: string, name: string, content: string): { name: string; file: string } {
  const file = join(dir, `${name}.md`);
  writeFileSync(file, content);
  return { name, file };
}

test("parseMemoryGraph reads valid entity/relation lines and skips invalid ones", () => {
  const content = [
    JSON.stringify({ type: "entity", name: "a", entityType: "person", observations: ["x"] }),
    "not json at all",
    JSON.stringify({ type: "relation", from: "a", to: "b", relationType: "knows" }),
    "",
  ].join("\n");
  const lines = parseMemoryGraph(content);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, "entity");
  assert.equal(lines[1].type, "relation");
});

test("renderMemoryGraph round-trips through parseMemoryGraph", () => {
  const lines = [
    { type: "entity" as const, name: "a", entityType: "person", observations: ["x"] },
    { type: "relation" as const, from: "a", to: "b", relationType: "knows" },
  ];
  const rendered = renderMemoryGraph(lines);
  assert.deepEqual(parseMemoryGraph(rendered), lines);
});

test("planMemorySync: a brand-new memory on an empty graph is a create", () => {
  const dir = mkdtempSync(join(tmpdir(), "trellis-memgraph-"));
  const memory = memoryFile(dir, "notes", "# Notes\nsome content\n");

  const plan = planMemorySync({ memories: [memory] }, undefined);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].action, "create");
  assert.ok(plan.nextGraph);
  assert.deepEqual(plan.nextGraph, [{ type: "entity", name: "notes", entityType: TRELLIS_MEMORY_ENTITY_TYPE, observations: ["# Notes\nsome content\n"] }]);
});

test("planMemorySync: identical content on both sides is already-synced, no write needed", () => {
  const dir = mkdtempSync(join(tmpdir(), "trellis-memgraph-"));
  const memory = memoryFile(dir, "notes", "same content\n");
  const existing = renderMemoryGraph([{ type: "entity", name: "notes", entityType: TRELLIS_MEMORY_ENTITY_TYPE, observations: ["same content\n"] }]);

  const plan = planMemorySync({ memories: [memory] }, existing);
  assert.equal(plan.items[0].action, "already-synced");
  assert.equal(plan.nextGraph, undefined);
});

test("planMemorySync: changed content updates the existing trellis-memory entity", () => {
  const dir = mkdtempSync(join(tmpdir(), "trellis-memgraph-"));
  const memory = memoryFile(dir, "notes", "new content\n");
  const existing = renderMemoryGraph([{ type: "entity", name: "notes", entityType: TRELLIS_MEMORY_ENTITY_TYPE, observations: ["old content\n"] }]);

  const plan = planMemorySync({ memories: [memory] }, existing);
  assert.equal(plan.items[0].action, "create");
  assert.deepEqual(plan.nextGraph, [{ type: "entity", name: "notes", entityType: TRELLIS_MEMORY_ENTITY_TYPE, observations: ["new content\n"] }]);
});

test("planMemorySync: a name colliding with a non-trellis-memory entity is a conflict, never overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "trellis-memgraph-"));
  const memory = memoryFile(dir, "notes", "canonical content\n");
  const existing = renderMemoryGraph([{ type: "entity", name: "notes", entityType: "person", observations: ["agent-created content"] }]);

  const plan = planMemorySync({ memories: [memory] }, existing);
  assert.equal(plan.items[0].action, "conflict");
  assert.equal(plan.nextGraph, undefined);
});

test("planMemorySync: a trellis-memory entity no longer in canonical is removed", () => {
  const existing = renderMemoryGraph([{ type: "entity", name: "stale", entityType: TRELLIS_MEMORY_ENTITY_TYPE, observations: ["gone"] }]);

  const plan = planMemorySync({ memories: [] }, existing);
  assert.equal(plan.items[0].action, "remove");
  assert.deepEqual(plan.nextGraph, []);
});

test("planMemorySync: every other entity and every relation is passed through completely untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "trellis-memgraph-"));
  const memory = memoryFile(dir, "notes", "content\n");
  const otherEntity = { type: "entity" as const, name: "runtime-created", entityType: "person", observations: ["something an agent added"] };
  const relation = { type: "relation" as const, from: "runtime-created", to: "someone-else", relationType: "works-with" };
  const existing = renderMemoryGraph([otherEntity, relation]);

  const plan = planMemorySync({ memories: [memory] }, existing);
  assert.ok(plan.nextGraph);
  assert.ok(plan.nextGraph!.some((l) => JSON.stringify(l) === JSON.stringify(otherEntity)));
  assert.ok(plan.nextGraph!.some((l) => JSON.stringify(l) === JSON.stringify(relation)));
});
