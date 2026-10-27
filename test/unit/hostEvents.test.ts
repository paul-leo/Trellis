import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sessionEndEvent,
  sessionStartEvent,
  toolCallEvent,
  type HostEvent,
  type ToolCallEvent,
} from "../../src/host/hostEvents.js";

// 任务 8.2:事件类型字段白名单——事件对象上不存在载荷字段,序列化后不含
// 构造时入参现场的凭据形态字符串。(类型层另有 _Eq 精确键断言,由 tsc 校验。)

const TOOL_CALL_KEYS = ["kind", "ts", "agent", "session", "provider", "tool", "durationMs", "result"];
const SESSION_START_KEYS = ["kind", "ts", "agent", "session", "workspaceRoot"];
const SESSION_END_KEYS = ["kind", "ts", "agent", "session"];

// 凭据形态哨兵(仅存在于测试入参现场,绝不应出现在事件里)。
const CREDENTIAL_SENTINELS = [
  "sk-ant-SECRET-SENTINEL",
  "ghp_SECRETSENTINEL000000",
  "AKIASECRETSENTINEL",
  "xoxb-SECRET-SENTINEL",
  "Bearer SECRET-SENTINEL",
];

test("toolCallEvent:事件对象只含白名单字段,无入参/结果载荷字段", () => {
  const ev = toolCallEvent({
    ts: 1,
    agent: "agent-x",
    session: "sess-1",
    provider: "upstream:foo",
    tool: "foo__bar",
    durationMs: 12,
    result: "ok",
  });
  assert.deepEqual(Object.keys(ev), TOOL_CALL_KEYS);
  assert.equal(ev.kind, "tool_call");
  // 显式确认典型载荷字段名不存在
  for (const payloadKey of ["input", "args", "arguments", "output", "payload", "data", "body"]) {
    assert.ok(!(payloadKey in ev), `载荷字段泄漏: ${payloadKey}`);
  }
});

test("sessionStartEvent / sessionEndEvent:白名单字段;workspace root 在开始事件上", () => {
  const start = sessionStartEvent({ ts: 2, agent: "a", session: "s", workspaceRoot: "/w" });
  assert.deepEqual(Object.keys(start), SESSION_START_KEYS);
  assert.equal(start.workspaceRoot, "/w");

  const startNull = sessionStartEvent({ ts: 2, agent: "a", session: "s", workspaceRoot: null });
  assert.equal(startNull.workspaceRoot, null);

  const end = sessionEndEvent({ ts: 3, agent: "a", session: "s" });
  assert.deepEqual(Object.keys(end), SESSION_END_KEYS);
});

test("事件序列化后不含构造现场入参的凭据形态字符串", () => {
  // 构造现场持有含凭据的工具入参(工厂不接收它们;类型层也禁止其上事件)。
  const callArgs = {
    api_key: CREDENTIAL_SENTINELS[0],
    token: CREDENTIAL_SENTINELS[1],
    secret: CREDENTIAL_SENTINELS[2],
    authorization: CREDENTIAL_SENTINELS[3],
    header: CREDENTIAL_SENTINELS[4],
  };
  assert.ok(JSON.stringify(callArgs).includes("SECRET-SENTINEL"), "入参现场应含哨兵(前提成立)");

  const events: HostEvent[] = [
    toolCallEvent({
      ts: 1,
      agent: "agent-x",
      session: "sess-1",
      provider: "upstream:foo",
      tool: "foo__bar",
      durationMs: 12,
      result: "error",
    }),
    sessionStartEvent({ ts: 1, agent: "agent-x", session: "sess-1", workspaceRoot: "/w" }),
    sessionEndEvent({ ts: 2, agent: "agent-x", session: "sess-1" }),
  ];
  for (const ev of events) {
    const serialized = JSON.stringify(ev);
    for (const sentinel of CREDENTIAL_SENTINELS) {
      assert.ok(!serialized.includes(sentinel), `序列化泄漏凭据形态: ${serialized}`);
    }
    assert.ok(!serialized.includes("SECRET-SENTINEL"));
  }
});

test("未类型化调用方多塞字段也被白名单裁掉(运行期键集不变)", () => {
  // 动态 import 的扩展可能用 JS 调工厂;工厂只拷贝白名单字段,多余字段进不了事件。
  const smuggled = {
    ts: 1,
    agent: "a",
    session: "s",
    provider: "p",
    tool: "t",
    durationMs: 1,
    result: "ok",
    input: { api_key: CREDENTIAL_SENTINELS[0] },
    raw: "SECRET-SENTINEL",
  };
  const ev = toolCallEvent(smuggled as unknown as Parameters<typeof toolCallEvent>[0]);
  assert.deepEqual(Object.keys(ev), TOOL_CALL_KEYS);
  assert.ok(!JSON.stringify(ev).includes("SECRET-SENTINEL"));
  assert.ok(!JSON.stringify(ev).includes("api_key"));
});

test("事件不可变(冻结),白名单字段不可被运行期改写", () => {
  const ev = toolCallEvent({
    ts: 1,
    agent: "a",
    session: "s",
    provider: "p",
    tool: "t",
    durationMs: 1,
    result: "ok",
  });
  assert.ok(Object.isFrozen(ev));
  const mutable = ev as unknown as { tool: string };
  assert.throws(() => {
    "use strict";
    mutable.tool = "hacked";
  });
});
