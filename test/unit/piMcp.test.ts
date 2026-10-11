/**
 * pi's native MCP renderer and version gate
 * (trellis-pi-native-mcp-migration tasks.md 1.1/1.2): the entry shape is
 * pinned against what pi 1.1.0 itself writes and reads (observed on the
 * real machine 2026-10-11) — no `type` field, stdio by `command`, http
 * by `url`, `${VAR}` env references that pi expands at spawn.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { piRenderer, supportsNativeMcp } from "../../src/adapters/piMcp.js";
import type { McpServerDef } from "../../src/core/types.js";

test("supportsNativeMcp: 1.1.0 and newer opt in", () => {
  assert.equal(supportsNativeMcp("1.1.0"), true);
  assert.equal(supportsNativeMcp("1.2.3"), true);
  assert.equal(supportsNativeMcp("2.0.0"), true);
});

test("supportsNativeMcp: older, malformed and unknown versions stay on the bridge", () => {
  assert.equal(supportsNativeMcp("1.0.9"), false);
  assert.equal(supportsNativeMcp("0.9.0"), false);
  assert.equal(supportsNativeMcp("not-a-version"), false);
  // undefined means the binary was not probeable — conservatively old
  // (design.md D2: writing config a pi cannot read is worse than keeping
  // a working bridge).
  assert.equal(supportsNativeMcp(undefined), false);
});

test("piRenderer: stdio entries carry command/args and ${VAR} env references, no type field", () => {
  const def: McpServerDef = {
    transport: "stdio",
    command: "uvx",
    args: ["minimax-mcp"],
    env: ["MINIMAX_API_KEY"],
    staticEnv: { MINIMAX_API_RESOURCE_MODE: "local" },
  };
  assert.deepEqual(piRenderer(def, "minimax"), {
    command: "uvx",
    args: ["minimax-mcp"],
    env: { MINIMAX_API_KEY: "${MINIMAX_API_KEY}", MINIMAX_API_RESOURCE_MODE: "local" },
  });
});

test("piRenderer: http entries carry url/headers, no type field", () => {
  const def: McpServerDef = {
    transport: "http",
    url: "https://example.com/mcp",
    headers: { Authorization: "Bearer ${DOCS_TOKEN}" },
  };
  assert.deepEqual(piRenderer(def, "docs"), {
    url: "https://example.com/mcp",
    headers: { Authorization: "Bearer ${DOCS_TOKEN}" },
  });
});

test("piRenderer: an agent-owned OAuth server renders as a bare url entry — auth material is never written", () => {
  // pi authorizes these itself via `pi mcp login <name>` into its own
  // token store (design.md D4); the canonical `auth` field is Trellis
  // routing metadata, not config content.
  const def: McpServerDef = { transport: "http", url: "https://mcp.figma.com/mcp", auth: "oauth" };
  assert.deepEqual(piRenderer(def, "figma"), { url: "https://mcp.figma.com/mcp" });
});

test("piRenderer: stdio entries without args still render an empty args array", () => {
  assert.deepEqual(piRenderer({ transport: "stdio", command: "node" }, "x"), { command: "node", args: [] });
});
