/**
 * trellis-memory-sync: `planMemorySync`/`parseMemoryGraph`/
 * `renderMemoryGraph` — pure logic, no filesystem access, matching
 * `parseMemoryGraph`'s own tolerant-of-bad-lines contract.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMemoryGraph, planMemoryExtraction, planMemorySync, renderExtractedMemoryFile, renderMemoryGraph, TRELLIS_MEMORY_ENTITY_TYPE } from "../../src/lib/memoryGraph.js";
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

test("renderExtractedMemoryFile: an entity with observations and no relations renders without a Relations section", () => {
  const entity = { type: "entity" as const, name: "Sprint Tasks Q2", entityType: "project", observations: ["task A", "task B"] };
  const rendered = renderExtractedMemoryFile(entity, []);
  assert.equal(
    rendered,
    ["# Sprint Tasks Q2", "", "**Type:** project", "", "## Observations", "- task A", "- task B", ""].join("\n"),
  );
});

test("renderExtractedMemoryFile: relations in both directions are included", () => {
  const entity = { type: "entity" as const, name: "alice", entityType: "person", observations: ["works on web series"] };
  const relations = [
    { type: "relation" as const, from: "alice", to: "web-series", relationType: "works-on" },
    { type: "relation" as const, from: "bob", to: "alice", relationType: "manages" },
    { type: "relation" as const, from: "unrelated", to: "someone-else", relationType: "knows" },
  ];
  const rendered = renderExtractedMemoryFile(entity, relations);
  assert.match(rendered, /## Relations/);
  assert.match(rendered, /- works-on -> web-series/);
  assert.match(rendered, /- bob -> manages -> this entity/);
  assert.doesNotMatch(rendered, /unrelated/);
});

test("planMemoryExtraction: a real, non-trellis-memory entity with observations is a create candidate", () => {
  const graph = [{ type: "entity" as const, name: "alice", entityType: "person", observations: ["knows the codebase"] }];
  const plan = planMemoryExtraction(graph, () => undefined);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].action, "create");
  assert.equal(plan.items[0].slug, "alice");
  assert.ok(plan.items[0].content?.includes("knows the codebase"));
});

test("planMemoryExtraction: a trellis-memory entity is never a candidate", () => {
  const graph = [{ type: "entity" as const, name: "notes", entityType: TRELLIS_MEMORY_ENTITY_TYPE, observations: ["already canonical"] }];
  const plan = planMemoryExtraction(graph, () => undefined);
  assert.equal(plan.items.length, 0);
});

test("planMemoryExtraction: an entity with zero observations is never extracted as its own file", () => {
  const graph = [{ type: "entity" as const, name: "empty-type-node", entityType: "category", observations: [] }];
  const plan = planMemoryExtraction(graph, () => undefined);
  assert.equal(plan.items.length, 0);
});

test("planMemoryExtraction: an existing file with identical rendered content is already-extracted, not created", () => {
  const graph = [{ type: "entity" as const, name: "alice", entityType: "person", observations: ["knows the codebase"] }];
  const rendered = renderExtractedMemoryFile(graph[0], []);
  const plan = planMemoryExtraction(graph, (slug) => (slug === "alice" ? rendered : undefined));
  assert.equal(plan.items[0].action, "already-extracted");
});

test("planMemoryExtraction: an existing file with different content is a conflict, not overwritten", () => {
  const graph = [{ type: "entity" as const, name: "alice", entityType: "person", observations: ["knows the codebase"] }];
  const plan = planMemoryExtraction(graph, (slug) => (slug === "alice" ? "hand-written, unrelated content\n" : undefined));
  assert.equal(plan.items[0].action, "conflict");
  assert.match(plan.items[0].detail, /already exists with different content/);
});

test("planMemoryExtraction: two entities slugging to the same filename is a conflict, not a silent merge", () => {
  const graph = [
    { type: "entity" as const, name: "Alice B", entityType: "person", observations: ["first"] },
    { type: "entity" as const, name: "alice-b", entityType: "person", observations: ["second, different entity"] },
  ];
  const plan = planMemoryExtraction(graph, () => undefined);
  assert.equal(plan.items[0].action, "create");
  assert.equal(plan.items[1].action, "conflict");
  assert.match(plan.items[1].detail, /collides with entity "Alice B"/);
});
