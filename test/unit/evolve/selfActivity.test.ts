/**
 * 防自激与可选源缺席测试(trellis-evolve 任务 11.3)。
 *
 * 对应 spec 场景:进化自身活动不自激(作业运行期间的调用/编辑不产生
 * 信号);可选源(agent-bridge 委托记录)缺席 → 运行继续并记 unavailable
 * 而非 error。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyEdits } from "../../../src/host/index.js";
import { sessionStartEvent, toolCallEvent } from "../../../src/host/hostEvents.js";
import {
  createSignalRecorder,
  isEvolveSelfActivity,
  readSignals,
} from "../../../src/evolve/recorder.js";
import { probeAgentBridgeSource, agentBridgeRecordsPath } from "../../../src/evolve/sources.js";
import { scratchHome } from "../../helpers/home.js";

test("作业运行期间的调用不产生信号:进化自身标识被过滤", () => {
  const home = scratchHome("self-call");
  const recorder = createSignalRecorder({ homeDir: home });

  // 作业自身的调用(两种标识形态)。
  recorder.handle(toolCallEvent({ ts: 1, agent: "trellis-evolve", session: "s-1", provider: "p", tool: "t", durationMs: 1, result: "ok" }));
  recorder.handle(toolCallEvent({ ts: 1, agent: "claude-code", session: "evolve-job-42", provider: "p", tool: "t", durationMs: 1, result: "ok" }));
  recorder.handle(sessionStartEvent({ ts: 1, agent: "trellis-evolve", session: "evolve-job-42", workspaceRoot: null }));

  // 用户会话照常记录。
  recorder.handle(toolCallEvent({ ts: 2, agent: "claude-code", session: "user-1", provider: "p", tool: "t", durationMs: 1, result: "ok" }));

  // 异步落盘契约:读盘前先 flush(热路径 handle 不同步写盘)。
  recorder.flush();
  const signals = readSignals(recorder.filePath);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.session, "user-1");
  assert.equal(isEvolveSelfActivity(toolCallEvent({ ts: 1, agent: "trellis-evolve", session: "x", provider: "p", tool: "t", durationMs: 1, result: "ok" })), true);
  assert.equal(isEvolveSelfActivity(toolCallEvent({ ts: 1, agent: "a", session: "evolve-job-1", provider: "p", tool: "t", durationMs: 1, result: "ok" })), true);
});

test("作业运行期间的编辑不产生信号:编辑面不经事件总线", async () => {
  const home = scratchHome("self-edit");
  const recorder = createSignalRecorder({ homeDir: home });
  // evolver 的编辑活动(经 host 门面做 staging 渲染同款编辑)。
  await applyEdits({
    homeDir: home,
    edits: [{ op: "write-file", path: join(home, "probe-out.txt"), content: "probe edit\n" }],
  });
  assert.equal(existsSync(join(home, "probe-out.txt")), true);
  assert.equal(existsSync(recorder.filePath), false, "编辑不产生任何信号记录");
});

test("可选源缺席:无委托存储时返回 unavailable 且不抛,有存储时 available", () => {
  const missing = scratchHome("source-missing");
  const probe = probeAgentBridgeSource(missing);
  assert.equal(probe.source, "agent-bridge");
  assert.equal(probe.status, "unavailable");
  assert.match(probe.note, /unavailable|其余信号源/);

  const present = scratchHome("source-present");
  mkdirSync(join(present, ".trellis", "tasks"), { recursive: true });
  writeFileSync(agentBridgeRecordsPath(present), '{"tasks":[]}\n');
  assert.equal(probeAgentBridgeSource(present).status, "available");
});
