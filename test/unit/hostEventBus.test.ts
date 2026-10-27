import assert from "node:assert/strict";
import { test } from "node:test";
import { HostEventBus, HostEventEmitter } from "../../src/lib/hostEventBus.js";
import type { HostEvent, ToolCallEvent } from "../../src/host/hostEvents.js";
import { BuiltinRegistry, type TrellisProvider } from "../../src/lib/mcpRuntime.js";

// 任务 8.3:事件总线——进程内、同步发出、订阅者异常被吞并警告、无订阅者零开销;
// 挂载于 BuiltinRegistry.callTool 咽喉点;上游与内建调用都产生事件;会话标识
// 在同一进程内一致。

const ctx = { homeDir: "/home/fixture", agentId: "codex" as const };

function fakeProvider(id: string, toolName: string, reply?: (name: string) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> | { content: Array<{ type: "text"; text: string }>; isError?: true }): TrellisProvider {
  return {
    id,
    listTools: () => [{ name: toolName, description: "fixture" }],
    callTool: async (name) => reply ? reply(name) : { content: [{ type: "text" as const, text: `${id}:${name}:ok` }] },
  };
}

async function exposedName(registry: BuiltinRegistry, contains: string): Promise<string> {
  const tools = await registry.listTools(ctx);
  const hit = tools.find((t) => t.name.includes(contains));
  assert.ok(hit, `exposed name containing ${contains} not found in ${tools.map((t) => t.name).join(", ")}`);
  return hit.name;
}

function collectEvents(): { events: HostEvent[]; listener: (ev: HostEvent) => void } {
  const events: HostEvent[] = [];
  return { events, listener: (ev) => { events.push(ev); } };
}

test("上游与内建调用都产生事件,元数据齐全且无载荷", async () => {
  const bus = new HostEventBus();
  const { events, listener } = collectEvents();
  bus.subscribe(listener);
  const emitter = new HostEventEmitter({ bus, agent: "codex", workspaceRoot: "/w", now: () => 1000 });
  const registry = new BuiltinRegistry(
    [fakeProvider("upstream", "foo.bar"), fakeProvider("memory", "beta")],
    () => {},
    (info) => emitter.toolCall(info),
  );

  const upName = await exposedName(registry, "foo");
  const memName = await exposedName(registry, "beta");
  const r1 = await registry.callTool(upName, { secret: "NEVER-IN-EVENT" }, ctx);
  const r2 = await registry.callTool(memName, {}, ctx);
  assert.equal(r1.isError, undefined);
  assert.equal(r2.isError, undefined);

  const calls = events.filter((e): e is ToolCallEvent => e.kind === "tool_call");
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((e) => ({ provider: e.provider, tool: e.tool, result: e.result })),
    [
      { provider: "upstream", tool: upName, result: "ok" },
      { provider: "memory", tool: memName, result: "ok" },
    ],
  );
  for (const e of calls) {
    assert.equal(e.session, emitter.sessionId);
    assert.equal(e.agent, "codex");
    assert.equal(e.ts, 1000);
    assert.ok(e.durationMs >= 0);
    assert.ok(!JSON.stringify(e).includes("NEVER-IN-EVENT"));
  }
});

test("订阅者抛异常/异步拒绝不影响调用结果,失败被吞并警告", async () => {
  const warnings: string[] = [];
  const bus = new HostEventBus((m) => warnings.push(m));
  const { events, listener } = collectEvents();
  bus.subscribe(() => { throw new Error("subscriber boom"); });
  bus.subscribe(listener);
  bus.subscribe(async () => { throw new Error("async subscriber boom"); });

  const emitter = new HostEventEmitter({ bus, agent: "codex", workspaceRoot: null });
  const registry = new BuiltinRegistry([fakeProvider("memory", "t1")], (m) => warnings.push(m), (info) => emitter.toolCall(info));
  const name = await exposedName(registry, "t1");
  const result = await registry.callTool(name, { arg: 1 }, ctx);

  // 调用结果与无订阅者时逐字段一致
  assert.deepEqual(result, { content: [{ type: "text", text: "memory:t1:ok" }] });
  // 好订阅者仍收到事件(故障隔离,不殃及兄弟订阅者)
  assert.equal(events.filter((e) => e.kind === "tool_call").length, 1);
  assert.ok(warnings.some((m) => m.includes("subscriber failed") && m.includes("subscriber boom")));
  // 异步拒绝也收口为警告(下一拍)
  await new Promise((r) => setImmediate(r));
  assert.ok(warnings.some((m) => m.includes("async subscriber boom")));
});

test("无订阅者时行为与引入前一致(含 observer 在位但无人订阅)", async () => {
  // 形态一:完全不挂 observer —— 与引入事件机制前相同的构造
  const plain = new BuiltinRegistry([fakeProvider("memory", "t1")], () => {});
  const plainName = await exposedName(plain, "t1");
  const plainResult = await plain.callTool(plainName, { a: 1 }, ctx);

  // 形态二:observer + 空总线 —— 零订阅者零开销,结果不变
  const warnings: string[] = [];
  const bus = new HostEventBus((m) => warnings.push(m));
  const emitter = new HostEventEmitter({ bus, agent: "codex", workspaceRoot: null });
  const withEmptyBus = new BuiltinRegistry([fakeProvider("memory", "t1")], () => {}, (info) => emitter.toolCall(info));
  const busName = await exposedName(withEmptyBus, "t1");
  assert.equal(busName, plainName);
  const busResult = await withEmptyBus.callTool(busName, { a: 1 }, ctx);

  assert.deepEqual(plainResult, busResult);
  assert.deepEqual(busResult, { content: [{ type: "text", text: "memory:t1:ok" }] });
  assert.equal(bus.subscriberCount, 0);
  assert.deepEqual(warnings, []);
});

test("会话标识在同一进程内一致;开始事件带 workspace root,结束事件不带", () => {
  const bus = new HostEventBus();
  const { events, listener } = collectEvents();
  bus.subscribe(listener);
  const emitter = new HostEventEmitter({ bus, agent: "codex", workspaceRoot: "/w", now: () => 7 });

  emitter.sessionStart();
  emitter.toolCall({ provider: "memory", tool: "t1", durationMs: 3, result: "ok" });
  emitter.sessionEnd();

  assert.equal(events.length, 3);
  const [start, call, end] = events as [HostEvent, HostEvent, HostEvent];
  assert.equal(start.kind, "session_start");
  assert.equal(call.kind, "tool_call");
  assert.equal(end.kind, "session_end");
  for (const e of events) {
    assert.equal(e.session, emitter.sessionId);
    assert.equal(e.agent, "codex");
    assert.equal(e.ts, 7);
  }
  assert.ok(start.kind === "session_start" && start.workspaceRoot === "/w");
  assert.ok(end.kind === "session_end" && !("workspaceRoot" in end));
});

test("结果类别:ok / error / timeout(超时从错误文本与异常形态判定)", async () => {
  const bus = new HostEventBus();
  const { events, listener } = collectEvents();
  bus.subscribe(listener);
  const emitter = new HostEventEmitter({ bus, agent: "codex", workspaceRoot: null });
  const provider: TrellisProvider = {
    id: "flaky",
    listTools: () => [
      { name: "fine", description: "" },
      { name: "slow", description: "" },
      { name: "boom", description: "" },
    ],
    callTool: async (name) => {
      if (name === "slow") return { content: [{ type: "text" as const, text: "operation timed out" }], isError: true };
      if (name === "boom") { const e = new Error("deadline exceeded"); e.name = "TimeoutError"; throw e; }
      return { content: [{ type: "text" as const, text: "fine" }] };
    },
  };
  const registry = new BuiltinRegistry([provider], () => {}, (info) => emitter.toolCall(info));
  const fine = await exposedName(registry, "fine");
  const slow = await exposedName(registry, "slow");
  const boom = await exposedName(registry, "boom");
  await registry.callTool(fine, {}, ctx);
  await registry.callTool(slow, {}, ctx);
  await registry.callTool(boom, {}, ctx);

  const results = events.filter((e): e is ToolCallEvent => e.kind === "tool_call").map((e) => e.result);
  assert.deepEqual(results, ["ok", "timeout", "timeout"]);
});

test("observer 自身抛异常也不改变调用结果(咽喉点透明)", async () => {
  const warnings: string[] = [];
  const registry = new BuiltinRegistry([fakeProvider("memory", "t1")], (m) => warnings.push(m), () => {
    throw new Error("observer boom");
  });
  const name = await exposedName(registry, "t1");
  const result = await registry.callTool(name, {}, ctx);
  assert.deepEqual(result, { content: [{ type: "text", text: "memory:t1:ok" }] });
  assert.ok(warnings.some((m) => m.includes("observer failed") && m.includes("observer boom")));
});
