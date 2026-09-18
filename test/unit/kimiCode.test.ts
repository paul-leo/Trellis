import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectInitReport } from "../../src/commands/init.js";
import { runKimi } from "../../src/commands/kimi.js";
import { KimiCodeAdapter } from "../../src/adapters/kimi-code.js";
import { openBackupSession } from "../../src/lib/backup.js";
import { loadCanonicalSource } from "../../src/core/canonical.js";

function home(): string {
  return mkdtempSync(join(tmpdir(), "trellis-kimi-"));
}

async function canonicalHome(): Promise<string> {
  const value = home();
  await collectInitReport(value);
  mkdirSync(join(value, ".trellis", "skills", "shared"), { recursive: true });
  writeFileSync(join(value, ".trellis", "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: shared\n---\n");
  writeFileSync(join(value, ".trellis", "managed.yaml"), "agents: [kimi-code]\n");
  writeFileSync(join(value, ".trellis", "mcp", "servers.yaml"), [
    "servers:",
    "  shared-tool:",
    "    transport: stdio",
    "    command: node",
    "    args: [fixture]",
    "runtime:",
    "  delivery:",
    "    kimi-code: mcp",
    "",
  ].join("\n"));
  mkdirSync(join(value, ".kimi-code"), { recursive: true });
  writeFileSync(join(value, ".kimi-code", "mcp.json"), JSON.stringify({ mcpServers: { "user-owned": { command: "user-tool" } } }, null, 2));
  return value;
}

test("KimiCodeAdapter: Runtime-only delivery writes one deferred Runtime entry and preserves user MCP", async () => {
  const value = await canonicalHome();
  const adapter = new KimiCodeAdapter(value);
  const canonical = loadCanonicalSource(value);
  const plan = await adapter.plan(canonical);
  const runtime = plan.find((item) => item.mcpWrite?.name === "trellis-runtime");
  assert.equal(runtime?.action, "create");
  assert.equal(plan.some((item) => item.kind === "skill" || item.kind === "instructions"), false);

  const backup = openBackupSession(value, "test-kimi");
  await adapter.apply(plan, backup);
  backup.finalize();
  const config = JSON.parse(readFileSync(join(value, ".kimi-code", "mcp.json"), "utf8"));
  assert.deepEqual(config.mcpServers["user-owned"], { command: "user-tool" });
  assert.deepEqual(config.mcpServers["trellis-runtime"], {
    command: "trellis",
    args: ["mcp-runtime", "--agent", "kimi-code"],
    deferred: true,
    startupTimeoutMs: 30000,
  });
  const secondPlan = await adapter.plan(loadCanonicalSource(value));
  assert.deepEqual(secondPlan, []);
});

test("KimiCodeAdapter: native delivery projects Kimi-specific Skills only", async () => {
  const value = await canonicalHome();
  const servers = readFileSync(join(value, ".trellis", "mcp", "servers.yaml"), "utf8").replace("kimi-code: mcp", "kimi-code: both");
  writeFileSync(join(value, ".trellis", "mcp", "servers.yaml"), servers);
  const adapter = new KimiCodeAdapter(value);
  const plan = await adapter.plan(loadCanonicalSource(value));
  assert.equal(plan.some((item) => item.kind === "skill" && item.target.endsWith(".kimi-code/skills/shared")), true);
  assert.equal(plan.some((item) => item.kind === "instructions" && item.target.endsWith(".kimi-code/AGENTS.md")), true);
});

test("trellis kimi: Runtime-only launch prepends an empty --skills-dir and forwards args", async () => {
  const value = await canonicalHome();
  const calls: { command: string; args: string[] }[] = [];
  let entriesAtExit = -1;
  const spawn = ((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = new EventEmitter() as EventEmitter & { once: EventEmitter["once"] };
    queueMicrotask(() => {
      entriesAtExit = readdirSync(args[1]).length;
      child.emit("exit", 0, null);
    });
    return child;
  }) as never;
  const result = await runKimi(["-p", "hello"], { homeDir: value, env: { PATH: process.env.PATH }, spawn });
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(2), ["-p", "hello"]);
  assert.equal(calls[0].args[0], "--skills-dir");
  assert.ok(existsSync(join(value, ".kimi-code")));
  const emptyRoot = calls[0].args[1];
  assert.equal(entriesAtExit, 0, "the runtime-only root is empty while launched");
  assert.equal(existsSync(emptyRoot), false, "the launcher cleans up its temporary root");
});
