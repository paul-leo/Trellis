import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { waitForShutdown } from "../../src/commands/mcpGateway.js";
import { HostEventBus, HostEventEmitter } from "../../src/lib/hostEventBus.js";
import { BuiltinRegistry, type TrellisProvider } from "../../src/lib/mcpRuntime.js";
import type { HostEvent } from "../../src/host/hostEvents.js";

// 任务 8.4:关闭路径在释放上游之前发"会话结束";stdin 关闭与 SIGTERM
// 触发结束事件;SIGKILL 不保证结束事件(以测试说明显式记录)。

function harness() {
  const order: string[] = [];
  const received: HostEvent[] = [];
  const provider: TrellisProvider = {
    id: "fake",
    listTools: () => [],
    callTool: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    close: async () => { order.push("registry-close"); },
  };
  const registry = new BuiltinRegistry([provider], () => {});
  const server = { close: async () => { order.push("server-close"); } };
  const bus = new HostEventBus();
  bus.subscribe((ev) => {
    received.push(ev);
    if (ev.kind === "session_end") order.push("session-end");
  });
  const emitter = new HostEventEmitter({ bus, agent: "codex", workspaceRoot: null, now: () => 42 });
  const stdin = new EventEmitter();
  const signalHandlers = new Map<string, () => void>();
  const seams = {
    stdin,
    onceSignal: (signal: string, listener: () => void) => { signalHandlers.set(signal, listener); },
  };
  return { order, received, registry, server, emitter, stdin, signalHandlers, seams };
}

test("stdin EOF('end')在释放上游之前发'会话结束'", async () => {
  const h = harness();
  const done = waitForShutdown(h.registry, h.server, h.emitter, h.seams);
  h.stdin.emit("end");
  await done;
  assert.deepEqual(h.order, ["session-end", "registry-close", "server-close"]);
  assert.deepEqual(h.received.map((e) => e.kind), ["session_end"]);
});

test("stdin 关闭('close')在释放上游之前发'会话结束'", async () => {
  const h = harness();
  const done = waitForShutdown(h.registry, h.server, h.emitter, h.seams);
  h.stdin.emit("close");
  await done;
  assert.deepEqual(h.order, ["session-end", "registry-close", "server-close"]);
  assert.deepEqual(h.received.map((e) => e.kind), ["session_end"]);
});

test("SIGTERM 在释放上游之前发'会话结束'", async () => {
  const h = harness();
  const done = waitForShutdown(h.registry, h.server, h.emitter, h.seams);
  const fire = h.signalHandlers.get("SIGTERM");
  assert.ok(fire, "SIGTERM handler not registered");
  fire();
  await done;
  assert.deepEqual(h.order, ["session-end", "registry-close", "server-close"]);
  assert.deepEqual(h.received.map((e) => e.kind), ["session_end"]);
});

test("多触发只 settle 一次:结束事件与上游释放各恰好一回", async () => {
  const h = harness();
  const done = waitForShutdown(h.registry, h.server, h.emitter, h.seams);
  h.stdin.emit("end");
  h.signalHandlers.get("SIGTERM")!();
  h.stdin.emit("close");
  await done;
  assert.deepEqual(h.order, ["session-end", "registry-close", "server-close"]);
  assert.equal(h.received.filter((e) => e.kind === "session_end").length, 1);
});

// 测试说明(任务 8.4 显式记录):SIGKILL —— 以及进程崩溃、断电 —— 不保证
// "会话结束"事件。处理器根本没有机会运行,这是操作系统语义而非实现取舍。
// 消费方(recorder 等订阅者)必须容忍缺失结束事件:11.6 的会话启动补偿评估
// 正是为此存在(强杀会话留下的累计信号在下次启动时收口)。SIGKILL 无法在
// 进程内测试(进程直接消失,断言无处着落),以本说明与"保证触发集合"断言
// 代替:可保证发出结束事件的路径恰好是 stdin end/close 与
// SIGTERM/SIGINT/SIGHUP,其中不存在任何 SIGKILL 语义的路径。
test("SIGKILL 不保证结束事件:保证触发集合恰为 stdin end/close + SIGTERM/SIGINT/SIGHUP", async () => {
  const h = harness();
  const done = waitForShutdown(h.registry, h.server, h.emitter, h.seams);
  assert.deepEqual([...h.signalHandlers.keys()].sort(), ["SIGHUP", "SIGINT", "SIGTERM"]);
  assert.equal(h.stdin.listenerCount("end"), 1);
  assert.equal(h.stdin.listenerCount("close"), 1);
  assert.ok(!h.signalHandlers.has("SIGKILL"), "SIGKILL must not be a registered trigger");
  // 收口:触发一次,避免悬挂 promise
  h.signalHandlers.get("SIGTERM")!();
  await done;
  assert.deepEqual(h.received.map((e) => e.kind), ["session_end"]);
});
