/**
 * Shared connect module (trellis-mcp-gateway-hosting tasks.md 1.3).
 *
 * These cover the behavior that was extracted out of
 * `src/pi-bridge/index.ts`, now at the module it moved to. The
 * bug-history-bearing parts get direct coverage here rather than only
 * through a consumer: a failed connect must close its transport (a real
 * leaked subprocess motivated that, trellis-mcp-connect-timeout), and
 * header templates must resolve through `resolveSecretEnv` rather than
 * being handed on as literal `${VAR}` text (trellis-migrate-env-var-alias).
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { connectServer, connectWithCleanup, resolveHeaders, withTimeout } from "../../src/lib/mcpConnect.js";
import type { McpServerDef, SecretsPolicy } from "../../src/core/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const sampleFixture = join(here, "..", "fixtures", "sample-mcp-server.js");
const hangingFixture = join(here, "..", "fixtures", "hanging-mcp-server.js");

// Matches the widened budget mcpConnectTimeout.test.ts already documents:
// a real subprocess spawn under full-suite concurrent load occasionally
// exceeds a small budget for reasons that are not a regression here.
const SHORT_TIMEOUT_MS = 8000;

const CLIENT_INFO = { name: "trellis-mcp-connect-test", version: "0.0.0" };

function emptyPolicy(): SecretsPolicy {
  return { allowedVars: [], rejectPatterns: [] };
}

function envFilePolicy(contents: string): SecretsPolicy {
  const dir = mkdtempSync(join(tmpdir(), "trellis-connect-secrets-"));
  const envFile = join(dir, ".env");
  writeFileSync(envFile, contents);
  return { allowedVars: [], rejectPatterns: [], envFile };
}

function killFixtureChildren(marker: string): void {
  try {
    execSync(`pkill -f ${JSON.stringify(marker)}`);
  } catch {
    // pkill exits non-zero when nothing matched — not an error here
  }
}

/** A transport that never completes `start()`, standing in for a server
 * process that is alive but never answers — the case `withTimeout` exists
 * to bound. Records whether it was closed. */
function hangingTransport(): Transport & { closed: boolean } {
  const transport = {
    closed: false,
    async start() {
      return new Promise<void>(() => {});
    },
    async send() {},
    async close() {
      transport.closed = true;
    },
  };
  return transport as unknown as Transport & { closed: boolean };
}

function fakeClient(connect: (transport: Transport) => Promise<void>): Client {
  return { connect } as unknown as Client;
}

test("withTimeout: resolves pass through unchanged", async () => {
  assert.equal(await withTimeout(Promise.resolve("real-value"), 1000, "should not fire"), "real-value");
});

test("withTimeout: a promise that never settles rejects at the timeout boundary", async () => {
  await assert.rejects(() => withTimeout(new Promise(() => {}), 50, "timed out as expected"), /timed out as expected/);
});

test("withTimeout: an early rejection passes through unmasked by the timeout error", async () => {
  await assert.rejects(() => withTimeout(Promise.reject(new Error("real failure")), 1000, "should not fire"), /real failure/);
});

test("connectWithCleanup: a timed-out connect closes the transport rather than leaking it", async () => {
  const transport = hangingTransport();
  const client = fakeClient((t) => t.start!());

  await assert.rejects(() => connectWithCleanup(client, transport, 50, "connect timed out"), /connect timed out/);
  assert.equal(transport.closed, true, "a timed-out connect must close its transport — an unclosed stdio transport is an orphaned child process");
});

test("connectWithCleanup: a rejected connect also closes the transport", async () => {
  const transport = hangingTransport();
  const client = fakeClient(async () => {
    throw new Error("handshake refused");
  });

  await assert.rejects(() => connectWithCleanup(client, transport, 1000, "should not fire"), /handshake refused/);
  assert.equal(transport.closed, true);
});

test("connectWithCleanup: a cleanup failure does not mask the original connect failure", async () => {
  const transport = {
    async start() {},
    async send() {},
    async close() {
      throw new Error("secondary cleanup error");
    },
  } as unknown as Transport;
  const client = fakeClient(async () => {
    throw new Error("the failure the caller needs to see");
  });

  await assert.rejects(() => connectWithCleanup(client, transport, 1000, "should not fire"), /the failure the caller needs to see/);
});

test("connectWithCleanup: a cleanup that never settles is bounded and preserves the original failure", async () => {
  const transport = {
    async start() {},
    async send() {},
    async close() {
      return new Promise<void>(() => {});
    },
  } as unknown as Transport;
  const client = fakeClient(async () => {
    throw new Error("remote upstream failed");
  });
  const started = Date.now();
  await assert.rejects(() => connectWithCleanup(client, transport, 1000, "should not fire"), /remote upstream failed/);
  assert.ok(Date.now() - started < 2500, "failed transport cleanup must not block Gateway startup indefinitely");
});

test("connectWithCleanup: a successful connect returns the client and leaves the transport open", async () => {
  const transport = hangingTransport();
  const client = fakeClient(async () => {});

  assert.equal(await connectWithCleanup(client, transport, 1000, "should not fire"), client);
  assert.equal(transport.closed, false);
});

test("resolveHeaders: a ${VAR} template resolves through resolveSecretEnv, never passed on as literal text", () => {
  const def: McpServerDef = { transport: "http", url: "https://example.test", headers: { Authorization: "Bearer ${TOKEN_NAME}" } };
  const headers = resolveHeaders(def, envFilePolicy("TOKEN_NAME=real-secret-value\n"));

  assert.deepEqual(headers, { Authorization: "Bearer real-secret-value" });
});

test("resolveHeaders: an unresolvable name becomes empty, not the raw placeholder", () => {
  const def: McpServerDef = { transport: "http", url: "https://example.test", headers: { Authorization: "Bearer ${MISSING_NAME}" } };
  const headers = resolveHeaders(def, envFilePolicy("OTHER=x\n"));

  assert.deepEqual(headers, { Authorization: "Bearer " });
});

test("resolveHeaders: no headers resolves to undefined, so no requestInit is built at all", () => {
  assert.equal(resolveHeaders({ transport: "http", url: "https://example.test" }, emptyPolicy()), undefined);
  assert.equal(resolveHeaders({ transport: "http", url: "https://example.test", headers: {} }, emptyPolicy()), undefined);
});

test("connectServer: an absent transport field connects over stdio (the canonical schema's default)", async () => {
  const marker = mkdtempSync(join(tmpdir(), "trellis-connect-dispatch-"));
  try {
    const client = await connectServer(
      { command: process.execPath, args: [sampleFixture, marker] },
      emptyPolicy(),
      SHORT_TIMEOUT_MS,
      CLIENT_INFO,
    );
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["echo", "env"],
      "a stdio connect through the extracted module reaches the real fixture server",
    );
    await client.close();
  } finally {
    killFixtureChildren(marker);
  }
});

test("connectServer: a stdio server that never answers rejects at the timeout and leaves no child behind", async () => {
  const marker = mkdtempSync(join(tmpdir(), "trellis-connect-hang-"));
  try {
    await assert.rejects(
      () => connectServer({ command: process.execPath, args: [hangingFixture, marker] }, emptyPolicy(), 300, CLIENT_INFO),
      /connect timed out after 300ms/,
    );
    // The point of connectWithCleanup: the hung child is gone, not orphaned.
    const survivors = (() => {
      try {
        return execSync(`pgrep -f ${JSON.stringify(marker)}`).toString().trim();
      } catch {
        return "";
      }
    })();
    assert.equal(survivors, "", `a timed-out stdio connect must leave no child process behind, found: ${survivors}`);
  } finally {
    killFixtureChildren(marker);
  }
});
