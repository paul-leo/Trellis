/**
 * 用户纠正上报入口测试(trellis-evolve 任务 11.2)。
 *
 * 对应 spec 场景:agent 在用户纠正其错误后调用上报入口 → 产生 kind 为
 * user-correction、带层归属的信号,文本已过擦除;原始文本不入库。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { readSignals } from "../../../src/evolve/recorder.js";
import { reportUserCorrection, userCorrectionFilePath } from "../../../src/evolve/report.js";
import { evolveStateDir } from "../../../src/evolve/stateDir.js";
import { scratchHome } from "../../helpers/home.js";

test("上报产生 user-correction 信号:文本已擦除、带层归属、原始文本不入库", () => {
  const home = scratchHome("report-correction");
  const secretText = "把 api_key=hunter2hunter2 换成 sk-ant-new-secret-token 再试";

  const signal = reportUserCorrection({
    homeDir: home,
    agent: "claude-code",
    session: "sess-1",
    text: secretText,
    workspaceRoot: "/tmp/ws-alpha",
    now: () => 5000,
  });

  assert.ok(signal);
  assert.equal(signal.kind, "user-correction");
  assert.equal(signal.source, "agent-report");
  assert.deepEqual(signal.layer, { kind: "workspace", root: "/tmp/ws-alpha" });
  assert.equal(signal.text.includes("hunter2hunter2"), false);
  assert.equal(signal.text.includes("sk-ant-new-secret-token"), false);
  assert.match(signal.text, /\[REDACTED\]/);

  const raw = readFileSync(userCorrectionFilePath(home), "utf-8");
  assert.ok(!raw.includes("hunter2hunter2"), "原始凭据文本不得入库");
  assert.ok(!raw.includes("sk-ant-new-secret-token"), "原始凭据文本不得入库");

  const signals = readSignals(userCorrectionFilePath(home));
  assert.equal(signals.length, 1);
  assert.deepEqual(signals[0], signal);
});

test("同进程多条上报进同一文件;无 workspace 归属记全局层;off 不写入", () => {
  const home = scratchHome("report-multi");
  reportUserCorrection({ homeDir: home, agent: "a", session: "s", text: "纠正 1" });
  reportUserCorrection({ homeDir: home, agent: "a", session: "s", text: "纠正 2", workspaceRoot: null });

  const signals = readSignals(userCorrectionFilePath(home));
  assert.equal(signals.length, 2);
  assert.deepEqual(signals[1]!.layer, { kind: "global" });

  const offHome = scratchHome("report-off");
  const result = reportUserCorrection({ homeDir: offHome, agent: "a", session: "s", text: "不写", enabled: () => false });
  assert.equal(result, null);
  assert.equal(existsSync(evolveStateDir(offHome)), false, "off 零副作用");
});
