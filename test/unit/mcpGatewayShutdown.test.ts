/**
 * End-to-end gateway lifecycle (trellis-mcp-gateway-hosting tasks.md 4.7).
 *
 * Deliberately a process-level test, not a mocked one. The failure this
 * guards against is precisely that a *real* process outlives its parent:
 * `StdioServerTransport` registers no EOF handler, and POSIX re-parents
 * orphans to launchd instead of killing them, so a gateway that doesn't
 * tear itself down leaks itself plus every upstream it spawned, once per
 * agent session, forever. Nothing short of spawning it for real and
 * looking for survivors can prove that doesn't happen.
 *
 * Also the only test that drives the gateway exactly as an agent does —
 * a real MCP `Client` over stdio against the built CLI — so it doubles as
 * the proof that gateway mode works end to end at all.
 */

import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cliEntry = join(repoRoot, "src", "cli.ts");
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const sampleFixture = join(here, "..", "fixtures", "sample-mcp-server.js");

function processesMatching(marker: string): string {
  try {
    return execSync(`pgrep -f ${JSON.stringify(marker)}`).toString().trim();
  } catch {
    return "";
  }
}

function killMatching(marker: string): void {
  try {
    execSync(`pkill -f ${JSON.stringify(marker)}`);
  } catch {
    // pkill exits non-zero when nothing matched — not an error here
  }
}

function gatewayHome(upstreamMarker: string): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-gw-e2e-"));
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  mkdirSync(join(home, ".trellis", "skills", "demo"), { recursive: true });
  writeFileSync(join(home, ".trellis", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: demo workflow\n---\n\n# Demo\n");
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(join(home, ".trellis", "secrets.policy.yaml"), "allowed_vars: []\nreject_patterns: []\n");
  writeFileSync(join(home, ".trellis", "managed.yaml"), "agents: [claude-code]\n");
  writeFileSync(
    join(home, ".trellis", "mcp", "servers.yaml"),
    `servers:
  fixture:
    transport: stdio
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(sampleFixture)}, ${JSON.stringify(upstreamMarker)}]
gateway:
  enabled: true
`,
  );
  return home;
}

/** Drives the gateway the way an agent does: spawn the CLI as a stdio MCP
 * server and speak the real protocol to it. */
async function connectToGateway(home: string, command = "mcp-gateway"): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: tsxBin,
    args: [cliEntry, command, "--agent", "claude-code"],
    env: { ...process.env, HOME: home } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "trellis-gateway-e2e", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

test("runtime edge: the first-class mcp-runtime entry exposes the same providers", async () => {
  const upstreamMarker = mkdtempSync(join(tmpdir(), "trellis-runtime-upstream-"));
  try {
    const { client, transport } = await connectToGateway(gatewayHome(upstreamMarker), "mcp-runtime");
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "trellis.skills.search"));
    assert.ok(tools.some((tool) => tool.name === "fixture__echo"));
    await client.close();
    await transport.close();
  } finally {
    killMatching(upstreamMarker);
  }
});

test("gateway end to end: an agent spawning it gets every in-scope server's tools, prefixed", async () => {
  const upstreamMarker = mkdtempSync(join(tmpdir(), "trellis-gw-upstream-"));
  try {
    const { client, transport } = await connectToGateway(gatewayHome(upstreamMarker));

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames.filter((name) => name.startsWith("fixture__")), ["fixture__echo", "fixture__env"]);
    assert.ok(toolNames.includes("trellis.skills.search"), "the runtime exposes the built-in skill provider");

    const result = (await client.callTool({ name: "fixture__echo", arguments: { message: "through the gateway" } })) as {
      content: Array<{ type: string; text: string }>;
    };
    assert.equal(result.content[0].text, "echo: through the gateway", "a call routed through the gateway to the real upstream and back");

    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === "trellis://skills/demo/SKILL.md"));
    const resource = await client.readResource({ uri: "trellis://skills/demo/SKILL.md" });
    assert.match(String(resource.contents[0].text), /# Demo/);

    await client.close();
    await transport.close();
  } finally {
    killMatching(upstreamMarker);
  }
});

test("gateway end to end: closing the agent's pipe leaves neither the gateway nor its upstream running", async () => {
  const upstreamMarker = mkdtempSync(join(tmpdir(), "trellis-gw-upstream-"));
  const home = gatewayHome(upstreamMarker);
  // Deliberately NOT StdioClientTransport: its close() kills the child it
  // spawned, which would make this test pass even with no EOF handling at
  // all (verified — it did). The real scenario is an agent process simply
  // going away, leaving the gateway holding a closed pipe and nothing
  // else. So the child is spawned directly and only its stdin is ended.
  const child = spawn(tsxBin, [cliEntry, "mcp-gateway", "--agent", "claude-code"], {
    env: { ...process.env, HOME: home },
    stdio: ["pipe", "pipe", "ignore"],
  });

  try {
    const replies = readJsonLines(child.stdout);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0.0.0" } },
      })}\n`,
    );
    await replies.next();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const listed = (await replies.next()).value as unknown as { result: { tools: Array<{ name: string }> } };
    const toolNames = listed.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames.filter((name) => name.startsWith("fixture__")), ["fixture__echo", "fixture__env"]);
    assert.ok(toolNames.includes("trellis.skills.search"));
    assert.notEqual(processesMatching(upstreamMarker), "", "precondition: the upstream is actually running");

    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    // The whole scenario, in one line: the pipe closes. Nothing is
    // signalled, nothing is killed.
    child.stdin.end();

    const exitCode = await Promise.race([exited, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000))]);
    assert.notEqual(exitCode, "timeout", "the gateway must exit on its own when its client's pipe closes");

    const deadline = Date.now() + 5_000;
    let survivors = processesMatching(upstreamMarker);
    while (survivors !== "" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      survivors = processesMatching(upstreamMarker);
    }
    assert.equal(survivors, "", `the upstream must not outlive the session, found: ${survivors}`);
  } finally {
    child.kill("SIGKILL");
    killMatching(upstreamMarker);
    killMatching(home);
  }
});

/** Yields one parsed JSON-RPC message per newline-delimited line. */
async function* readJsonLines(stream: NodeJS.ReadableStream): AsyncGenerator<Record<string, unknown>> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += String(chunk);
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield JSON.parse(line) as Record<string, unknown>;
      index = buffer.indexOf("\n");
    }
  }
}
