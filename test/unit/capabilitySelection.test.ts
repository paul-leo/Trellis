import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildCapabilityInventory, parseCapabilitySelectionFile, resolveSelectedNames, selectionContains } from "../../src/core/capabilitySelection.js";

function selectionFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "trellis-selection-"));
  const file = join(dir, "selection.yaml");
  writeFileSync(file, content);
  return file;
}

test("parseCapabilitySelectionFile: parses item selections and per-agent routes", () => {
  const result = parseCapabilitySelectionFile(selectionFile(`
skills: [api-review, e2e-test]
mcp_servers: [tanka, figma]
memories: none
mcp_routes:
  codex:
    mode: gateway
    servers: [figma]
  claude-code:
    mode: direct
runtime_delivery:
  codex: mcp
  claude-code: both
`));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.selection.skills, ["api-review", "e2e-test"]);
  assert.deepEqual(result.selection.mcpServers, ["tanka", "figma"]);
  assert.equal(result.selection.memories, "none");
  assert.deepEqual(result.selection.mcpRoutes.codex, { mode: "gateway", servers: ["figma"] });
  assert.deepEqual(result.selection.mcpRoutes["claude-code"], { mode: "direct" });
  assert.deepEqual(result.selection.runtimeDelivery, { codex: "mcp", "claude-code": "both" });
});

test("parseCapabilitySelectionFile: defaults omitted selections to all", () => {
  const result = parseCapabilitySelectionFile(selectionFile("{}\n"));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.selection.skills, "all");
  assert.equal(result.selection.mcpServers, "all");
  assert.equal(result.selection.memories, "all");
  assert.deepEqual(result.selection.mcpRoutes, {});
  assert.deepEqual(result.selection.runtimeDelivery, {});
});

test("parseCapabilitySelectionFile: refuses unknown agents and invalid modes", () => {
  const unknown = parseCapabilitySelectionFile(selectionFile("mcp_routes:\n  cursor:\n    mode: direct\n"));
  assert.equal(unknown.ok, false);
  const invalid = parseCapabilitySelectionFile(selectionFile("mcp_routes:\n  codex:\n    mode: relay\n"));
  assert.equal(invalid.ok, false);
  const invalidDelivery = parseCapabilitySelectionFile(selectionFile("runtime_delivery:\n  codex: relay\n"));
  assert.equal(invalidDelivery.ok, false);
});

test("selection helpers: resolve names and membership without leaking unselected items", () => {
  assert.deepEqual(resolveSelectedNames(["a", "missing", "a"], ["a", "b"]), ["a"]);
  assert.deepEqual(resolveSelectedNames("all", ["a", "b"]), ["a", "b"]);
  assert.deepEqual(resolveSelectedNames("none", ["a", "b"]), []);
  assert.equal(selectionContains(["a"], "a"), true);
  assert.equal(selectionContains(["a"], "b"), false);
  assert.equal(selectionContains("all", "b"), true);
  assert.equal(selectionContains("none", "a"), false);
});

test("buildCapabilityInventory: marks source items against canonical and preserves unsupported memory notices", () => {
  const inventory = buildCapabilityInventory(
    { skillNames: ["existing-skill", "new-skill"], mcpServerNames: ["tanka", "figma"] },
    {
      skills: [{ name: "existing-skill", dir: "/tmp/existing-skill" }],
      mcp: { servers: { tanka: { transport: "stdio" } }, knownHostInjected: [] },
      memories: [{ name: "project", file: "/tmp/project.md" }],
    },
    [{ name: "claude-code:native", detail: "native memory reader is not implemented" }],
  );
  assert.equal(inventory.skills.find((item) => item.name === "existing-skill")?.status, "unchanged");
  assert.equal(inventory.skills.find((item) => item.name === "new-skill")?.status, "new");
  assert.equal(inventory.mcpServers.find((item) => item.name === "figma")?.status, "new");
  assert.equal(inventory.nativeMemory[0].status, undefined);
});
