/**
 * `trellis sync`'s argv target parsing (src/lib/syncArgs.ts) — this
 * exact class of bug (only `rest[0]` was ever checked as a candidate
 * target, so a flag placed first was mistaken for an unknown target,
 * breaking `trellis sync --dry-run`) had no test coverage before it was
 * found by manual review, not a failing test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSyncArgs } from "../../src/lib/syncArgs.js";

test("no args: no target, no unknown arg", () => {
  assert.deepEqual(parseSyncArgs([]), { target: undefined, unknownArg: undefined });
});

test("target-first: `sync skills --dry-run`", () => {
  assert.deepEqual(parseSyncArgs(["skills", "--dry-run"]), { target: "skills", unknownArg: undefined });
});

test("flags-first: `sync --dry-run` alone (the regression)", () => {
  assert.deepEqual(parseSyncArgs(["--dry-run"]), { target: undefined, unknownArg: undefined });
});

test("flags-first with a target: `sync --dry-run instructions --json`", () => {
  assert.deepEqual(parseSyncArgs(["--dry-run", "instructions", "--json"]), { target: "instructions", unknownArg: undefined });
});

test("a genuinely unknown, non-flag argument is still rejected", () => {
  assert.deepEqual(parseSyncArgs(["bogus-target"]), { target: undefined, unknownArg: "bogus-target" });
});

test("an unknown non-flag argument is still caught even alongside a valid flag", () => {
  assert.deepEqual(parseSyncArgs(["--json", "bogus-target"]), { target: undefined, unknownArg: "bogus-target" });
});
