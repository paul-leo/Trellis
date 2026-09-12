import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { probeMcpServer } from "../../src/lib/mcpProbe.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureServer = join(here, "..", "fixtures", "sample-mcp-server.js");

test("probeMcpServer: success path against the fixture server", async () => {
  const result = await probeMcpServer({ transport: "stdio", command: "node", args: [fixtureServer] }, process.env);
  assert.equal(result.ok, true);
  assert.equal(result.serverInfo?.name, "trellis-fixture-server");
});

test("probeMcpServer: process exits before responding", async () => {
  const result = await probeMcpServer(
    { transport: "stdio", command: "node", args: ["-e", "process.exit(1)"] },
    process.env,
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /exited/);
});

test("probeMcpServer: hangs past the timeout", async () => {
  const result = await probeMcpServer(
    { transport: "stdio", command: "node", args: ["-e", "setTimeout(() => {}, 60000)"] },
    process.env,
    100,
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /no response within/);
});
