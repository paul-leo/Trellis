/**
 * trellis-mcp-connect-timeout: proves a stdio server that never answers
 * the protocol (real subprocess, not a mock) fails within a bounded
 * timeout instead of hanging the bridge forever, and — the actual bug
 * this change fixes — never prevents a second, normal server's tools
 * from registering. Uses a short timeout override (the bridge's own
 * test-only seam, same pattern as `homeDir`) so this suite stays fast;
 * production default (10s) is asserted separately by inspecting the
 * exported default, not by waiting for it.
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import trellisMcpBridge, { withTimeout } from "../../src/pi-bridge/index.js";
import { scratchHome as sharedScratchHome, seedAgentPresence, seedCanonical } from "../helpers/home.js";

const here = dirname(fileURLToPath(import.meta.url));
const hangingFixture = join(here, "..", "fixtures", "hanging-mcp-server.js");
const sampleFixture = join(here, "..", "fixtures", "sample-mcp-server.js");
// History: raised 3000→8000 after a flake where the "normal" fixture's
// connect exceeded a 3000ms budget under full-suite load. That budget was
// actually being eaten by the version-negotiation probe, which waited out
// its own 3s timeout against the then-silent fixture before the legacy
// fallback even started — the fixture now answers `server/discover` with
// -32601 like any SDK-built server, so a real connect completes in ~100ms
// and 3000ms is again a wide margin, not a tight one. Still far below the
// untested-by-waiting 10s production default.
const SHORT_TIMEOUT_MS = 3000;

interface CapturedTool {
  name: string;
}

function fakePi(): { registerTool: (tool: CapturedTool) => void; tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  return { registerTool: (tool) => tools.push(tool), tools };
}

function scratchHome(): string {
  return sharedScratchHome("connect-timeout");
}

function writeServersYaml(home: string, body: string): void {
  seedCanonical(home, { serversYaml: body, instructions: "# instructions\n", secretsPolicyYaml: "allowed_vars: []\nreject_patterns: []\n" });
}

function killFixtureChildren(marker: string): void {
  try {
    execSync(`pkill -f ${JSON.stringify(marker)}`);
  } catch {
    // pkill exits non-zero when nothing matched — not an error here
  }
}

test("withTimeout: a promise that resolves before the timeout passes its value through unchanged", async () => {
  const result = await withTimeout(Promise.resolve("real-value"), 1000, "should not fire");
  assert.equal(result, "real-value");
});

test("withTimeout: a promise that never settles rejects at the timeout boundary", async () => {
  const neverSettles = new Promise<never>(() => {});
  await assert.rejects(() => withTimeout(neverSettles, 50, "timed out as expected"), /timed out as expected/);
});

test("withTimeout: a promise that rejects before the timeout passes that rejection through unchanged, not masked by a timeout error", async () => {
  await assert.rejects(
    () => withTimeout(Promise.reject(new Error("real failure")), 1000, "should not fire"),
    /real failure/,
  );
});

test("a server that never answers initialize fails within the timeout, not forever", async () => {
  const home = scratchHome();
  writeServersYaml(
    home,
    `servers:\n  hanging:\n    transport: stdio\n    command: node\n    args:\n      - ${hangingFixture}\n      - before-initialize\n      - ${home}\n`,
  );
  try {
    const pi = fakePi();
    const start = Date.now();
    await trellisMcpBridge(pi as never, home, SHORT_TIMEOUT_MS);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < SHORT_TIMEOUT_MS * 4, `expected the bridge to resolve well within a few multiples of its ${SHORT_TIMEOUT_MS}ms timeout even under concurrent test-suite load, took ${elapsed}ms`);
    assert.equal(pi.tools.length, 0, "a server that never connects registers no tools");
  } finally {
    killFixtureChildren(home);
  }
});

test("a server that hangs on tools/list (after a real initialize) fails within the timeout", async () => {
  const home = scratchHome();
  writeServersYaml(
    home,
    `servers:\n  hanging:\n    transport: stdio\n    command: node\n    args:\n      - ${hangingFixture}\n      - before-tools-list\n      - ${home}\n`,
  );
  try {
    const pi = fakePi();
    const start = Date.now();
    await trellisMcpBridge(pi as never, home, SHORT_TIMEOUT_MS);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < SHORT_TIMEOUT_MS * 4, `expected the bridge to resolve well within a few multiples of its ${SHORT_TIMEOUT_MS}ms timeout even under concurrent test-suite load, took ${elapsed}ms`);
    assert.equal(pi.tools.length, 0, "a server whose tools/list never answers registers no tools");
  } finally {
    killFixtureChildren(home);
  }
});

test("one hanging server does not prevent a second, normal server's tools from registering (the actual bug)", async () => {
  const home = scratchHome();
  writeServersYaml(
    home,
    [
      "servers:",
      "  hanging:",
      "    transport: stdio",
      "    command: node",
      `    args:`,
      `      - ${hangingFixture}`,
      `      - before-initialize`,
      `      - ${home}`,
      "  normal:",
      "    transport: stdio",
      "    command: node",
      "    args:",
      `      - ${sampleFixture}`,
      `      - ${home}`,
      "",
    ].join("\n"),
  );
  try {
    const pi = fakePi();
    const start = Date.now();
    await trellisMcpBridge(pi as never, home, SHORT_TIMEOUT_MS);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < SHORT_TIMEOUT_MS * 4, `expected the bridge to resolve well within a few multiples of its ${SHORT_TIMEOUT_MS}ms timeout even under concurrent test-suite load, took ${elapsed}ms`);
    assert.ok(
      pi.tools.some((t) => t.name === "normal__echo"),
      "the normal server's tools must still register despite the other server hanging",
    );
    assert.equal(pi.tools.filter((t) => t.name.startsWith("hanging")).length, 0);
  } finally {
    killFixtureChildren(home);
  }
});
