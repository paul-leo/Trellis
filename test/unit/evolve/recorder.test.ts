/**
 * gateway 进程内 signal recorder 测试(trellis-evolve 任务 11.1)。
 *
 * 对应 spec 场景:载荷不入库、并发会话互不阻塞且不丢信号、off 零副作用;
 * 外加 secrets 擦除模式与层归属派生。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { sessionEndEvent, sessionStartEvent, toolCallEvent } from "../../../src/host/hostEvents.js";
import { eraseSecrets } from "../../../src/evolve/erase.js";
import { createSignalRecorder, readSignals } from "../../../src/evolve/recorder.js";
import { evolveStateDir } from "../../../src/evolve/stateDir.js";
import { scratchHome } from "../../helpers/home.js";

test("载荷不入库:字段白名单 + secrets 擦除,任何凭据形态不落盘", () => {
  const home = scratchHome("recorder-payload");
  const recorder = createSignalRecorder({ homeDir: home });
  const secret = "sk-ant-do-not-store-this-token";
  const secretAssign = "api_key=hunter2hunter2";

  recorder.handle(sessionStartEvent({ ts: 1, agent: `agent-${secretAssign}`, session: "s1", workspaceRoot: null }));
  recorder.handle(
    toolCallEvent({
      ts: 2,
      agent: `agent-${secretAssign}`,
      session: "s1",
      provider: "p",
      tool: `tool-${secret}`,
      durationMs: 5,
      result: "ok",
    }),
  );

  const raw = readFileSync(recorder.filePath, "utf-8");
  assert.ok(!raw.includes(secret), "凭据形态不得出现在信号文件");
  assert.ok(!raw.includes(secretAssign), "key=value 凭据形态不得出现在信号文件");
  assert.match(raw, /\[REDACTED\]/);

  const signals = readSignals(recorder.filePath);
  assert.equal(signals.length, 2);
  // 字段白名单:每条记录的键集恰为信封 + 载荷字段,无任何载体字段。
  const toolCall = signals[1]!;
  assert.deepEqual(
    Object.keys(toolCall).sort(),
    ["agent", "collectedAt", "durationMs", "kind", "layer", "result", "session", "source", "stableId", "tool", "ts", "provider"].sort(),
  );
  assert.equal(toolCall.kind, "tool-call");
  assert.equal(toolCall.source, "gateway-event");
  assert.equal(toolCall.stableId, null);
});

test("并发两会话互不阻塞且不丢信号;跨进程各自分文件", () => {
  const home = scratchHome("recorder-concurrent");
  const recorder = createSignalRecorder({ homeDir: home, now: () => 1000 });

  recorder.handle(sessionStartEvent({ ts: 1, agent: "a", session: "sa", workspaceRoot: null }));
  recorder.handle(sessionStartEvent({ ts: 1, agent: "b", session: "sb", workspaceRoot: "/tmp/ws-b" }));
  // 交错写入 100 + 100(同步 append 逐行原子,无锁、无等待)。
  for (let i = 0; i < 100; i++) {
    recorder.handle(toolCallEvent({ ts: 2, agent: "a", session: "sa", provider: "p", tool: "t", durationMs: 1, result: "ok" }));
    recorder.handle(toolCallEvent({ ts: 2, agent: "b", session: "sb", provider: "p", tool: "t", durationMs: 1, result: "ok" }));
  }
  recorder.handle(sessionEndEvent({ ts: 3, agent: "a", session: "sa" }));
  recorder.handle(sessionEndEvent({ ts: 3, agent: "b", session: "sb" }));

  const signals = readSignals(recorder.filePath);
  assert.equal(signals.length, 204);
  assert.equal(signals.filter((s) => s.session === "sa").length, 102);
  assert.equal(signals.filter((s) => s.session === "sb").length, 102);

  // 跨进程:另一个 recorder(另一次 now → 另一文件)互不覆盖。
  const other = createSignalRecorder({ homeDir: home, now: () => 2000 });
  other.handle(toolCallEvent({ ts: 4, agent: "c", session: "sc", provider: "p", tool: "t", durationMs: 1, result: "ok" }));
  assert.notEqual(other.filePath, recorder.filePath);
  assert.equal(readSignals(recorder.filePath).length, 204);
  assert.equal(readSignals(other.filePath).length, 1);
});

test("off 时不写入任何记录:目录与文件都不产生", () => {
  const home = scratchHome("recorder-off");
  const recorder = createSignalRecorder({ homeDir: home, enabled: () => false });
  recorder.handle(sessionStartEvent({ ts: 1, agent: "a", session: "s", workspaceRoot: null }));
  recorder.handle(toolCallEvent({ ts: 2, agent: "a", session: "s", provider: "p", tool: "t", durationMs: 1, result: "ok" }));
  recorder.handle(sessionEndEvent({ ts: 3, agent: "a", session: "s" }));

  assert.equal(existsSync(evolveStateDir(home)), false, "off 零副作用:状态目录都不创建");
  assert.equal(existsSync(recorder.filePath), false);
});

test("层归属派生:session 的 workspace 归属贯穿该会话信号,无归属记全局层", () => {
  const home = scratchHome("recorder-layer");
  const recorder = createSignalRecorder({ homeDir: home });

  recorder.handle(sessionStartEvent({ ts: 1, agent: "a", session: "ws-s", workspaceRoot: "/tmp/ws-alpha" }));
  recorder.handle(toolCallEvent({ ts: 2, agent: "a", session: "ws-s", provider: "p", tool: "t", durationMs: 1, result: "ok" }));
  // 无 session_start 的会话:全局层。
  recorder.handle(toolCallEvent({ ts: 2, agent: "a", session: "orphan", provider: "p", tool: "t", durationMs: 1, result: "error" }));

  const signals = readSignals(recorder.filePath);
  assert.deepEqual(signals[0]!.layer, { kind: "workspace", root: "/tmp/ws-alpha" });
  assert.deepEqual(signals[1]!.layer, { kind: "workspace", root: "/tmp/ws-alpha" });
  assert.deepEqual(signals[2]!.layer, { kind: "global" });
  // workspaceRoot 不独立入库:session-start 信号无 workspaceRoot 字段。
  assert.ok(!("workspaceRoot" in signals[0]!));
});

test("eraseSecrets:已知凭据形态擦除,普通内容原样", () => {
  assert.equal(eraseSecrets("sk-abc123def456ghi"), "[REDACTED]");
  assert.equal(eraseSecrets("ghp_0123456789abcdef0123"), "[REDACTED]");
  assert.equal(eraseSecrets("Authorization: Bearer abcdef0123456789"), "Authorization: Bearer [REDACTED]");
  assert.equal(eraseSecrets("token = abcdef012345"), "token = [REDACTED]");
  // JWT(三段 base64url)与 Slack token 形态。
  assert.equal(
    eraseSecrets("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c"),
    "[REDACTED]",
  );
  assert.equal(eraseSecrets("xoxb-1234567890-abcdefghijkl"), "[REDACTED]");
  assert.equal(eraseSecrets("workspace-toml-invalid"), "workspace-toml-invalid");
});
