/**
 * pi bridge (trellis-secrets-env-management): proves the bridge's stdio
 * connection actually receives values through `resolveSecretEnv`, not
 * raw ambient `process.env` — by spawning the real fixture server and
 * reading back its own env via a real "env" tool call, not a mock.
 */

import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import trellisMcpBridge from "../../src/pi-bridge/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureServer = join(here, "..", "fixtures", "sample-mcp-server.js");

interface CapturedTool {
  name: string;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string }> }>;
}

function fakePi(): {
  registerTool: (tool: CapturedTool) => void;
  tools: CapturedTool[];
  on: (event: "session_shutdown", handler: () => Promise<void> | void) => void;
  shutdown: () => Promise<void>;
} {
  const tools: CapturedTool[] = [];
  let shutdownHandler: (() => Promise<void> | void) | undefined;
  return {
    registerTool: (tool) => tools.push(tool),
    tools,
    on: (_event, handler) => {
      shutdownHandler = handler;
    },
    shutdown: async () => {
      await shutdownHandler?.();
    },
  };
}

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "trellis-pibridge-"));
}

function initCanonical(home: string, secretsPolicyYaml: string): void {
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(join(home, ".trellis", "secrets.policy.yaml"), secretsPolicyYaml);
  writeFileSync(
    join(home, ".trellis", "mcp", "servers.yaml"),
    // `home` (a fresh mkdtemp path) doubles as a per-test-unique argv marker
    // for killFixtureChildren — the bridge never closes the MCP client it
    // opens (correct for a long-lived pi process; see this test's own
    // comment on why that's out of scope here), so without a targeted kill
    // the spawned fixture subprocess outlives the test and this file never
    // exits.
    `servers:\n  fixture:\n    transport: stdio\n    command: node\n    args:\n      - ${fixtureServer}\n      - ${home}\n    env:\n      - PI_BRIDGE_TEST_VAR\n`,
  );
}

function killFixtureChildren(marker: string): void {
  try {
    execSync(`pkill -f ${JSON.stringify(marker)}`);
  } catch {
    // pkill exits non-zero when nothing matched — not an error here
  }
}

function fixtureChildIsAlive(home: string): boolean {
  try {
    execFileSync("pgrep", ["-f", `${fixtureServer} ${home}`]);
    return true;
  } catch {
    return false;
  }
}

test("pi bridge: with env_file set, the spawned server receives the file's value, never the ambient one", async () => {
  const home = scratchHome();
  const envFile = join(home, "secrets.env");
  writeFileSync(envFile, "PI_BRIDGE_TEST_VAR=from-env-file\n");
  initCanonical(home, `allowed_vars: []\nreject_patterns: []\nenv_file: ${envFile}\n`);

  process.env.PI_BRIDGE_TEST_VAR = "ambient-value-should-not-be-used";
  try {
    const pi = fakePi();
    await trellisMcpBridge(pi as never, home);

    const envTool = pi.tools.find((t) => t.name === "fixture__env");
    assert.ok(envTool, "expected fixture__env to be registered");
    const result = await envTool!.execute("call-1", { name: "PI_BRIDGE_TEST_VAR" });
    assert.equal(result.content[0]?.text, "from-env-file");
  } finally {
    delete process.env.PI_BRIDGE_TEST_VAR;
    killFixtureChildren(home);
  }
});

test("pi bridge: with no env_file, the spawned server receives the ambient process.env value (pre-existing behavior, unchanged)", async () => {
  const home = scratchHome();
  initCanonical(home, "allowed_vars: []\nreject_patterns: []\n");

  process.env.PI_BRIDGE_TEST_VAR = "ambient-value";
  try {
    const pi = fakePi();
    await trellisMcpBridge(pi as never, home);

    const envTool = pi.tools.find((t) => t.name === "fixture__env");
    assert.ok(envTool, "expected fixture__env to be registered");
    const result = await envTool!.execute("call-1", { name: "PI_BRIDGE_TEST_VAR" });
    assert.equal(result.content[0]?.text, "ambient-value");
  } finally {
    delete process.env.PI_BRIDGE_TEST_VAR;
    killFixtureChildren(home);
  }
});

test("pi bridge: a resolved header actually reaches the outbound HTTP request to a remote server", async () => {
  let capturedHeaders: IncomingHttpHeaders | undefined;
  const server = createServer((req, res) => {
    capturedHeaders ??= req.headers;
    res.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a real TCP address");
  const url = `http://127.0.0.1:${address.port}/mcp`;

  const home = scratchHome();
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(join(home, ".trellis", "secrets.policy.yaml"), "allowed_vars: []\nreject_patterns: []\n");
  writeFileSync(
    join(home, ".trellis", "mcp", "servers.yaml"),
    `servers:\n  remote:\n    transport: http\n    url: "${url}"\n    headers:\n      Authorization: "Bearer \${HTTP_HEADER_TEST_VAR}"\n`,
  );

  process.env.HTTP_HEADER_TEST_VAR = "resolved-header-value";
  try {
    const pi = fakePi();
    await trellisMcpBridge(pi as never, home); // the server doesn't speak MCP and 500s — the bridge logs and continues, never throws
    assert.equal(capturedHeaders?.authorization, "Bearer resolved-header-value");
  } finally {
    delete process.env.HTTP_HEADER_TEST_VAR;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("pi bridge: session shutdown closes connected stdio children", async () => {
  const home = scratchHome();
  initCanonical(home, "allowed_vars: []\nreject_patterns: []\n");
  const pi = fakePi();
  try {
    await trellisMcpBridge(pi as never, home);
    assert.ok(pi.tools.some((tool) => tool.name === "fixture__echo"));

    assert.equal(fixtureChildIsAlive(home), true, "expected the fixture MCP child to be alive before shutdown");

    await pi.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fixtureChildIsAlive(home), false, "expected shutdown to release the fixture MCP child");
  } finally {
    killFixtureChildren(home);
  }
});

test("pi bridge: session shutdown closes every connected server's child, not just one (pi-bridge-lifecycle)", async () => {
  const home = scratchHome();
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(join(home, ".trellis", "secrets.policy.yaml"), "allowed_vars: []\nreject_patterns: []\n");
  writeFileSync(
    join(home, ".trellis", "mcp", "servers.yaml"),
    // Two independent fixture servers sharing `home` as their common argv
    // marker — deliberately, so a single pgrep count proves *both* were
    // running before shutdown and *neither* survives it (killFixtureChildren
    // targets the same marker for cleanup).
    [
      "servers:",
      "  fixture-a:",
      "    transport: stdio",
      "    command: node",
      "    args:",
      `      - ${fixtureServer}`,
      `      - ${home}`,
      "  fixture-b:",
      "    transport: stdio",
      "    command: node",
      "    args:",
      `      - ${fixtureServer}`,
      `      - ${home}`,
      "",
    ].join("\n"),
  );
  const pi = fakePi();
  try {
    await trellisMcpBridge(pi as never, home);
    assert.ok(pi.tools.some((t) => t.name === "fixture-a__echo"));
    assert.ok(pi.tools.some((t) => t.name === "fixture-b__echo"));

    const aliveBefore = execFileSync("pgrep", ["-f", `${fixtureServer} ${home}`]).toString().trim().split("\n").length;
    assert.equal(aliveBefore, 2, "expected both fixture children alive before shutdown");

    await pi.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(fixtureChildIsAlive(home), false, "expected shutdown to release every connected client, not just one");
  } finally {
    killFixtureChildren(home);
  }
});

test("pi bridge: shutdown is idempotent — calling it twice closes each client at most once, no error", async () => {
  const home = scratchHome();
  initCanonical(home, "allowed_vars: []\nreject_patterns: []\n");
  const pi = fakePi();
  try {
    await trellisMcpBridge(pi as never, home);
    assert.ok(pi.tools.some((tool) => tool.name === "fixture__echo"));

    await pi.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fixtureChildIsAlive(home), false, "expected the first shutdown to release the child");

    // The second call must not throw (e.g. from double-closing an already-
    // closed client) and must not resurrect or duplicate anything.
    await pi.shutdown();
    assert.equal(fixtureChildIsAlive(home), false, "expected the second shutdown to be a no-op, not an error or a respawn");
  } finally {
    killFixtureChildren(home);
  }
});
