/**
 * 14.1 fixture 机器端到端(trellis-evolve)。
 *
 * 流水(tasks 14.1 验证锚文,顺序即断言链):
 *   植入 `workspace-toml-invalid` → 信号 → 引擎循环 → workspace 层提案
 *   → L1 前闸可采纳 → Class B 呈现、带外批准 → 单会话写入 → lesson
 *   → 全局层逐字节不变;
 *   验证:集成测试断言每类档案记录存在。
 *
 * fixture 机器无模型:引擎循环走 12.2 的 rule-based 兜底通道
 * (delegate/spawn 双不可用),全程不 spawn 真实 agent CLI。L1 前闸走
 * 真实 runChecks / createStaging / applyEdits(host 门面)。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readArchiveRecords } from "../../../src/evolve/archive.js";
import {
  VERDICT_ARCHIVE_KIND,
  evaluateL1Proposal,
} from "../../../src/evolve/gate.js";
import { proposeFromSignals } from "../../../src/evolve/propose.js";
import {
  PROPOSAL_DECISION_ARCHIVE_KIND,
  decideProposal,
  enqueueProposal,
} from "../../../src/evolve/pending.js";
import { listPendingSummaries } from "../../../src/evolve/agentView.js";
import { APPLY_ARCHIVE_KIND, applyApprovedProposals } from "../../../src/evolve/apply.js";
import { LESSON_ARCHIVE_KIND, recordLesson } from "../../../src/evolve/lesson.js";
import { classifyProposalRisk } from "../../../src/evolve/risk.js";
import { appendSignalLine, readSignals, signalFilePath } from "../../../src/evolve/recorder.js";
import type { Lesson, Signal } from "../../../src/evolve/types.js";
import { runChecks } from "../../../src/host/index.js";
import { scratchHome, seedAgentPresence, seedCanonical } from "../../helpers/home.js";

const FIXED_TS = Date.parse("2026-10-26T12:00:00Z");

test("14.1 fixture 端到端:植入 → 信号 → 引擎循环 → 提案 → L1 → Class B 带外批准 → 单会话写入 → lesson", async () => {
  // ── 植入:fixture 机器(全局层 canonical + workspace 层坏 TOML)────────
  const home = scratchHome("e2e-home");
  seedAgentPresence(home, ["claude-code", "codex"]);
  seedCanonical(home, {
    managed: ["claude-code", "codex"],
    instructions: "# instructions\n",
    serversYaml: "servers: {}\n",
  });
  const workspace = mkdtempSync(join(tmpdir(), "trellis-e2e-ws-"));
  mkdirSync(join(workspace, ".codex"), { recursive: true });
  const brokenToml = join(workspace, ".codex", "config.toml");
  writeFileSync(brokenToml, "x = [unclosed\n");

  // 全局层字节快照(流水终点逐字节不变)。
  const globalFiles = [
    join(home, ".trellis", "managed.yaml"),
    join(home, ".trellis", "agents.md"),
    join(home, ".trellis", "mcp", "servers.yaml"),
    join(home, ".claude.json"),
    join(home, ".codex", "config.toml"),
  ];
  const globalBefore = globalFiles.map((path) => readFileSync(path, "utf-8"));

  // ── 信号:doctor 发现 → doctor finding 形态信号(stableId = entry.id)──
  const pre = await runChecks({ homeDir: home, workspaceRoot: workspace });
  const invalid = pre.entries.find((entry) => entry.kind === "workspace-toml-invalid");
  assert.ok(invalid, `植入应被发现: ${JSON.stringify(pre.entries)}`);
  assert.deepEqual(invalid.layer, { kind: "workspace", root: workspace });

  const signal: Signal = {
    kind: "tool-call",
    source: "gateway-event",
    stableId: invalid.id,
    collectedAt: FIXED_TS,
    layer: { kind: "workspace", root: workspace },
    ts: FIXED_TS,
    agent: "codex",
    session: "sess-e2e",
    provider: "fixture",
    tool: "read",
    durationMs: 1,
    result: "ok",
  };
  const signalPath = signalFilePath(home, FIXED_TS);
  appendSignalLine(signalPath, signal);

  // ── 引擎循环(rule-based 兜底通道:fixture 机器无模型)────────────────
  const loop = proposeFromSignals({
    signals: [signal],
    findings: pre.entries,
    availability: { delegate: false, spawn: false },
    now: () => FIXED_TS,
    readFile: (path) => readFileSync(path, "utf-8"),
  });
  assert.equal(loop.channel, "rule-based");
  assert.equal(loop.proposals.length, 1, `skipped=${JSON.stringify(loop.skipped)}`);
  const proposal = loop.proposals[0]!;

  // ── workspace 层提案 ──────────────────────────────────────────────────
  assert.equal(proposal.kind, "workspace-config-fix");
  assert.deepEqual(proposal.layer, { kind: "workspace", root: workspace });
  assert.equal(proposal.target, brokenToml);

  // ── L1 前闸可采纳(真实 runChecks / staging / applyEdits)─────────────
  const gate = await evaluateL1Proposal({
    homeDir: home,
    workspaceRoot: workspace,
    proposal,
    now: () => FIXED_TS,
  });
  assert.equal(gate.decision, "acceptable", gate.reason);
  assert.equal(gate.verdict.status, "ok");

  // ── Class B 呈现、带外批准 ────────────────────────────────────────────
  const risk = classifyProposalRisk(proposal, { homeDir: home });
  assert.equal(risk.riskClass, "B");
  enqueueProposal({ homeDir: home, proposal, riskClass: "B", riskRuleId: risk.ruleId, now: () => FIXED_TS });
  const presented = listPendingSummaries(home);
  assert.equal(presented.length, 1);
  assert.equal(presented[0]!.riskClass, "B");
  assert.equal(presented[0]!.id, proposal.id);
  // 带外批准:非交互流水经 API 直调(管理面 TTY 门不参与)。
  const decided = decideProposal({ homeDir: home, id: proposal.id, decision: "approved" });
  assert.equal(decided.ok, true);

  // ── 单会话写入 ────────────────────────────────────────────────────────
  const applied = await applyApprovedProposals({ homeDir: home, agents: [] });
  assert.ok(applied.runId !== null);
  assert.deepEqual(applied.appliedProposalIds, [proposal.id]);
  // 修复生效:失败行被注释。
  assert.match(readFileSync(brokenToml, "utf-8"), /^# x = \[unclosed/m);

  // ── lesson ────────────────────────────────────────────────────────────
  const lesson: Lesson = {
    id: "e2e-lesson-1",
    createdAt: FIXED_TS,
    cue: "workspace toml 解析失败行可机械注释",
    body: "rule-based 通道对 workspace-toml-invalid 的失败行加 # 注释收口。",
    evidence: [{ kind: "doctor-finding", findingId: invalid.id, layer: proposal.layer }],
    confidence: 0.7,
    layer: proposal.layer,
  };
  const lessonResult = recordLesson({ homeDir: home, lesson, memoryEnabled: false });
  assert.equal(lessonResult.memoryStatus, "skipped");

  // ── 全局层逐字节不变 ──────────────────────────────────────────────────
  globalFiles.forEach((path, i) => {
    assert.equal(readFileSync(path, "utf-8"), globalBefore[i], `全局层被改动: ${path}`);
  });

  // ── 每类档案记录存在 ──────────────────────────────────────────────────
  const archiveKinds = new Set(readArchiveRecords(home).map((entry) => entry.kind));
  assert.ok(archiveKinds.has(VERDICT_ARCHIVE_KIND), "verdict 档案");
  assert.ok(archiveKinds.has(PROPOSAL_DECISION_ARCHIVE_KIND), "proposal-decision 档案");
  assert.ok(archiveKinds.has(APPLY_ARCHIVE_KIND), "apply-run 档案");
  assert.ok(archiveKinds.has(LESSON_ARCHIVE_KIND), "lesson 档案");
  // 信号记录(按进程分文件的信号流)。
  const signals = readSignals(signalPath);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.stableId, invalid.id);
});
