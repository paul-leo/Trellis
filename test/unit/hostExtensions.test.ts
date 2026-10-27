import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostEventBus, HostEventEmitter } from "../../src/lib/hostEventBus.js";
import { loadHostExtensions } from "../../src/lib/hostExtensions.js";
import { BuiltinRegistry, type TrellisProvider } from "../../src/lib/mcpRuntime.js";

// 任务 8.6:外部扩展注册与故障隔离。扩展只从 canonical 扩展清单
// (~/.trellis/mcp/extensions.yaml,条目含 id 与 load)装载,模块导出
// activate(ctx) 返回 { providers?, subscribers? };provider 与订阅者经同一
// 注册面。单个扩展失败不影响核心 provider、上游、其他扩展;无清单时
// gateway 行为与引入前一致。

const CTX_AGENT = "codex" as const;

function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-ext-"));
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  return home;
}

function writeExtensionsManifest(home: string, entries: Array<{ id: string; load: string }>): void {
  const yaml = ["extensions:", ...entries.map((e) => `  - id: ${e.id}\n    load: ${JSON.stringify(e.load)}`)].join("\n") + "\n";
  writeFileSync(join(home, ".trellis", "mcp", "extensions.yaml"), yaml);
}

/** Provider+subscriber 双出的好扩展:provider 回显 agent,订阅者把事件
 * kind 追加到 home 下的日志文件(顺带证明 ctx 字段送达)。 */
const EXT_GOOD = `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
export function activate(ctx) {
  return {
    providers: [{
      id: "ext-good",
      listTools: () => [{ name: "ext_ping", description: "fixture" }],
      callTool: async (name) => ({ content: [{ type: "text", text: "good:" + name + ":" + ctx.agent }] }),
    }],
    subscribers: [(ev) => { appendFileSync(join(ctx.homeDir, "good-events.log"), ev.kind + "\\n"); }],
  };
}
`;

/** 只出订阅者的扩展(recorder 形态)。 */
const EXT_SUBSCRIBER_ONLY = `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
export function activate(ctx) {
  return { subscribers: [(ev) => { appendFileSync(join(ctx.homeDir, "sub-events.log"), ev.kind + "\\n"); }] };
}
`;

const EXT_BAD_IMPORT = `throw new Error("boom on import");\n`;

const EXT_BAD_ACTIVATE = `export function activate() { throw new Error("boom on activate"); }\n`;

/** 清单之外的磁盘模块:一旦被 import 就留下标记文件——装载面之外的
 * 模块不得被装载,此文件必须始终不存在。 */
const EXT_ORPHAN = `
import { writeFileSync } from "node:fs";
writeFileSync(new URL("./orphan-imported.marker", import.meta.url), "imported\\n");
export function activate() { return {}; }
`;

const EXT_NO_ACTIVATE = `export const somethingElse = 1;\n`;

function writeModules(dir: string): Record<string, string> {
  const paths: Record<string, string> = {};
  const modules: Record<string, string> = {
    "ext-good.mjs": EXT_GOOD,
    "ext-subscriber-only.mjs": EXT_SUBSCRIBER_ONLY,
    "ext-bad-import.mjs": EXT_BAD_IMPORT,
    "ext-bad-activate.mjs": EXT_BAD_ACTIVATE,
    "ext-orphan.mjs": EXT_ORPHAN,
    "ext-no-activate.mjs": EXT_NO_ACTIVATE,
  };
  for (const [name, content] of Object.entries(modules)) {
    const path = join(dir, name);
    writeFileSync(path, content);
    paths[name] = path;
  }
  return paths;
}

function fakeCoreProvider(): TrellisProvider {
  return {
    id: "core",
    listTools: () => [{ name: "core_tool", description: "fixture" }],
    callTool: async (name) => ({ content: [{ type: "text" as const, text: `core:${name}` }] }),
  };
}

test("仅清单内扩展被装载:磁盘上的未声明模块不被 import", async () => {
  const home = fixtureHome();
  const mods = writeModules(home);
  writeExtensionsManifest(home, [{ id: "good", load: mods["ext-good.mjs"]! }]);

  const loaded = await loadHostExtensions({ homeDir: home, agent: CTX_AGENT, workspaceRoot: null }, () => {});

  assert.equal(loaded.providers.length, 1);
  assert.equal(loaded.providers[0]!.id, "ext-good");
  assert.equal(loaded.subscribers.length, 1);
  assert.deepEqual(loaded.failures, []);
  assert.ok(!existsSync(join(home, "orphan-imported.marker")), "orphan module must never be imported");
});

test("订阅者型扩展经同一契约装载:收到进程事件,工具列表不受影响", async () => {
  const home = fixtureHome();
  const mods = writeModules(home);
  writeExtensionsManifest(home, [{ id: "recorder", load: mods["ext-subscriber-only.mjs"]! }]);

  // 与 runMcpEdge 相同的注册面:bus + emitter + registry
  const bus = new HostEventBus();
  const events = new HostEventEmitter({ bus, agent: CTX_AGENT, workspaceRoot: "/ws", now: () => 1 });
  const loaded = await loadHostExtensions({ homeDir: home, agent: CTX_AGENT, workspaceRoot: "/ws" }, () => {});
  for (const subscriber of loaded.subscribers) bus.subscribe(subscriber);
  const registry = new BuiltinRegistry([fakeCoreProvider(), ...loaded.providers], () => {}, (info) => events.toolCall(info));

  events.sessionStart();
  const tools = await registry.listTools({ homeDir: home, agentId: CTX_AGENT });
  const name = tools.find((t) => t.name.includes("core_tool"))!.name;
  await registry.callTool(name, {}, { homeDir: home, agentId: CTX_AGENT });
  events.sessionEnd();

  assert.deepEqual(readFileSync(join(home, "sub-events.log"), "utf-8").trim().split("\n"), [
    "session_start",
    "tool_call",
    "session_end",
  ]);
  // 工具列表只有核心 provider 的
  assert.deepEqual(tools.map((t) => t.name), [name]);
});

test("扩展加载失败被隔离:好扩展与核心 provider 照常工作,失败被报告", async () => {
  const home = fixtureHome();
  const mods = writeModules(home);
  writeExtensionsManifest(home, [
    { id: "bad-import", load: mods["ext-bad-import.mjs"]! },
    { id: "good", load: mods["ext-good.mjs"]! },
    { id: "bad-activate", load: mods["ext-bad-activate.mjs"]! },
  ]);

  const warnings: string[] = [];
  const loaded = await loadHostExtensions({ homeDir: home, agent: CTX_AGENT, workspaceRoot: null }, (m) => warnings.push(m));

  // 好扩展完好
  assert.equal(loaded.providers.length, 1);
  assert.equal(loaded.subscribers.length, 1);
  // 两个失败都被报告(而非静默)
  assert.deepEqual(
    loaded.failures.map((f) => ({ id: f.id, stage: f.stage })),
    [
      { id: "bad-import", stage: "import" },
      { id: "bad-activate", stage: "activate" },
    ],
  );
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((m) => m.includes("failed")));

  // 经同一注册面:核心 provider 与好扩展的工具都可用,事件照发
  const bus = new HostEventBus();
  const events = new HostEventEmitter({ bus, agent: CTX_AGENT, workspaceRoot: null });
  for (const subscriber of loaded.subscribers) bus.subscribe(subscriber);
  const registry = new BuiltinRegistry([fakeCoreProvider(), ...loaded.providers], () => {}, (info) => events.toolCall(info));
  const tools = await registry.listTools({ homeDir: home, agentId: CTX_AGENT });
  const extName = tools.find((t) => t.name.includes("ext_ping"))!.name;
  const result = await registry.callTool(extName, {}, { homeDir: home, agentId: CTX_AGENT });
  assert.deepEqual(result, { content: [{ type: "text", text: `good:ext_ping:${CTX_AGENT}` }] });
  assert.equal(readFileSync(join(home, "good-events.log"), "utf-8").trim(), "tool_call");
});

test("无扩展零变化:无清单时空载、零失败、零警告", async () => {
  const home = fixtureHome();
  const warnings: string[] = [];
  const loaded = await loadHostExtensions({ homeDir: home, agent: CTX_AGENT, workspaceRoot: null }, (m) => warnings.push(m));
  assert.deepEqual(loaded, { providers: [], subscribers: [], failures: [] });
  assert.deepEqual(warnings, []);

  // 注册面组合与无扩展时逐字节一致
  const registry = new BuiltinRegistry([fakeCoreProvider(), ...loaded.providers], () => {});
  const tools = await registry.listTools({ homeDir: home, agentId: CTX_AGENT });
  assert.equal(tools.length, 1);
  assert.ok(tools[0]!.name.includes("core_tool"));
});

test("清单与条目的坏形态都被收口为失败而非崩溃", async () => {
  const home = fixtureHome();
  const mods = writeModules(home);

  // 非 YAML
  writeFileSync(join(home, ".trellis", "mcp", "extensions.yaml"), "extensions: [unclosed\n");
  let warnings: string[] = [];
  let loaded = await loadHostExtensions({ homeDir: home, agent: CTX_AGENT, workspaceRoot: null }, (m) => warnings.push(m));
  assert.deepEqual(loaded.providers, []);
  assert.deepEqual(loaded.failures.map((f) => f.stage), ["manifest"]);
  assert.equal(warnings.length, 1);

  // extensions 不是列表
  writeFileSync(join(home, ".trellis", "mcp", "extensions.yaml"), "extensions: {}\n");
  warnings = [];
  loaded = await loadHostExtensions({ homeDir: home, agent: CTX_AGENT, workspaceRoot: null }, (m) => warnings.push(m));
  assert.deepEqual(loaded.failures.map((f) => f.stage), ["manifest"]);

  // 条目缺 load / 模块缺 activate
  writeExtensionsManifest(home, [
    { id: "missing-load", load: "" },
    { id: "no-activate", load: mods["ext-no-activate.mjs"]! },
  ]);
  warnings = [];
  loaded = await loadHostExtensions({ homeDir: home, agent: CTX_AGENT, workspaceRoot: null }, (m) => warnings.push(m));
  assert.deepEqual(loaded.failures.map((f) => ({ id: f.id, stage: f.stage })), [
    { id: "<manifest>", stage: "invalid" },
    { id: "no-activate", stage: "invalid" },
  ]);
});
