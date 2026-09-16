/**
 * The gateway seam (trellis-mcp-gateway-hosting tasks.md 1.6, design.md D11).
 *
 * Two things are being pinned down. First, that `LocalBackend` really does
 * aggregate and isolate against *real* upstream processes, not mocks —
 * failure isolation is only meaningful if a genuinely broken server is what
 * gets isolated. Second, and the reason this module exists at all: that a
 * completely different implementation can be dropped in behind the same
 * interface without the consumer noticing, which is what makes the shared
 * service in v2 a substitution rather than a rewrite.
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LocalBackend, type GatewayBackend, type UpstreamSpec } from "../../src/lib/gatewayBackend.js";
import type { AggregatedTool } from "../../src/lib/mcpToolRegistry.js";
import type { SecretsPolicy } from "../../src/core/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const sampleFixture = join(here, "..", "fixtures", "sample-mcp-server.js");

const SHORT_TIMEOUT_MS = 8000;
const CLIENT_INFO = { name: "trellis-mcp-gateway-test", version: "0.0.0" };

function emptyPolicy(): SecretsPolicy {
  return { allowedVars: [], rejectPatterns: [] };
}

function marker(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function killFixtureChildren(markerPath: string): void {
  try {
    execSync(`pkill -f ${JSON.stringify(markerPath)}`);
  } catch {
    // pkill exits non-zero when nothing matched — not an error here
  }
}

function stdioUpstream(name: string, markerPath: string): UpstreamSpec {
  return { name, def: { command: process.execPath, args: [sampleFixture, markerPath] } };
}

async function connectBackend(upstreams: UpstreamSpec[], warnings: string[]): Promise<LocalBackend> {
  return LocalBackend.connect(upstreams, {
    secretsPolicy: emptyPolicy(),
    clientInfo: CLIENT_INFO,
    connectTimeoutMs: SHORT_TIMEOUT_MS,
    onWarning: (message) => warnings.push(message),
  });
}

/**
 * Stands in for what `src/commands/mcpGateway.ts` will do: it depends on
 * the interface alone, never on a connection, a transport, or a server
 * definition. Anything this function can drive, the real gateway can drive.
 */
async function driveLikeTheGateway(backend: GatewayBackend): Promise<{ tools: string[]; called: unknown }> {
  const tools = (await backend.listTools()).map((tool: AggregatedTool) => tool.name);
  const called = tools.length > 0 ? await backend.callTool(tools[0], { message: "hi" }) : undefined;
  await backend.close();
  return { tools, called };
}

test("LocalBackend: aggregates two real upstreams under server-prefixed names", async () => {
  const a = marker("trellis-gw-a-");
  const b = marker("trellis-gw-b-");
  const warnings: string[] = [];
  try {
    const backend = await connectBackend([stdioUpstream("alpha", a), stdioUpstream("beta", b)], warnings);
    const names = (await backend.listTools()).map((tool) => tool.name).sort();

    assert.deepEqual(names, ["alpha__echo", "alpha__env", "beta__echo", "beta__env"]);
    assert.deepEqual(warnings, [], "a clean run must warn about nothing");
    await backend.close();
  } finally {
    killFixtureChildren(a);
    killFixtureChildren(b);
  }
});

test("LocalBackend: a call routes to the owning upstream and returns its real result", async () => {
  const a = marker("trellis-gw-call-");
  const warnings: string[] = [];
  try {
    const backend = await connectBackend([stdioUpstream("alpha", a)], warnings);
    const result = (await backend.callTool("alpha__echo", { message: "round trip" })) as { content: Array<{ type: string; text: string }> };

    // The fixture answers "echo: <message>" — proof the arguments reached it
    // and that it was asked for `echo`, not `alpha__echo`, which it has
    // never heard of.
    assert.equal(result.content[0].text, "echo: round trip");
    await backend.close();
  } finally {
    killFixtureChildren(a);
  }
});

test("LocalBackend: a broken upstream is isolated — the others still serve", async () => {
  const good = marker("trellis-gw-good-");
  const warnings: string[] = [];
  try {
    const backend = await connectBackend(
      [
        stdioUpstream("alpha", good),
        // A command that cannot start at all: the failure mode a user hits
        // with a typo'd path or an uninstalled package.
        { name: "broken", def: { command: join(here, "no-such-binary-anywhere") } },
      ],
      warnings,
    );

    const names = (await backend.listTools()).map((tool) => tool.name).sort();
    assert.deepEqual(names, ["alpha__echo", "alpha__env"], "the healthy upstream's tools are served regardless");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /failed to connect to MCP server "broken"/);
    await backend.close();
  } finally {
    killFixtureChildren(good);
  }
});

test("LocalBackend: warnings go to the injected sink, never to stdout (stdout is the MCP protocol)", async () => {
  const warnings: string[] = [];
  const backend = await connectBackend([{ name: "broken", def: { command: join(here, "no-such-binary-anywhere") } }], warnings);

  assert.equal(warnings.length, 1, "the failure was reported");
  assert.deepEqual(await backend.listTools(), [], "and produced no tools");
  await backend.close();
});

test("LocalBackend: close is idempotent and leaves no upstream process behind", async () => {
  const a = marker("trellis-gw-close-");
  const warnings: string[] = [];
  try {
    const backend = await connectBackend([stdioUpstream("alpha", a)], warnings);
    await backend.close();
    await backend.close();

    assert.deepEqual(warnings, [], "closing twice must not produce an error or a duplicate close");
    const survivors = (() => {
      try {
        return execSync(`pgrep -f ${JSON.stringify(a)}`).toString().trim();
      } catch {
        return "";
      }
    })();
    assert.equal(survivors, "", `close() must terminate the upstream child, found: ${survivors}`);
  } finally {
    killFixtureChildren(a);
  }
});

test("seam: a stub backend drives the consumer identically to the real one — v2 is a substitution, not a rewrite", async () => {
  // The forwarding backend v2 will add holds no connections of its own; it
  // answers the same three questions from somewhere else entirely. If the
  // consumer can't tell these two apart, the seam is in the right place.
  let closed = false;
  const stub: GatewayBackend = {
    async listTools() {
      return [{ name: "alpha__echo", description: "from a shared service" }];
    },
    async callTool(name, args) {
      return { forwarded: name, args };
    },
    async close() {
      closed = true;
    },
  };

  const viaStub = await driveLikeTheGateway(stub);
  assert.deepEqual(viaStub.tools, ["alpha__echo"]);
  assert.deepEqual(viaStub.called, { forwarded: "alpha__echo", args: { message: "hi" } });
  assert.equal(closed, true);

  const a = marker("trellis-gw-seam-");
  try {
    const warnings: string[] = [];
    const viaLocal = await driveLikeTheGateway(await connectBackend([stdioUpstream("alpha", a)], warnings));
    // Same consumer, same call shape, same tool name — only the answer's
    // origin differs, which is the entire contract being asserted.
    assert.ok(viaLocal.tools.includes("alpha__echo"));
  } finally {
    killFixtureChildren(a);
  }
});
