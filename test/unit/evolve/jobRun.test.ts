/**
 * 作业体 `runEvolveJob`(11.5 括注"作业即运行移植引擎";14.1 fixture E2E
 * 流水的生产入口)。真实 runChecks / staging / applyEdits(host 门面),
 * fixture 机器无模型(rule-based 通道);全程不 spawn 真实 agent CLI。
 * auto-A 分支经 proposeFn/evaluateL1Fn 注入缝直达治理层(真实分类/校验/
 * 应用/lesson)。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readArchiveRecords, appendArchiveRecord } from "../../../src/evolve/archive.js";
import { APPLY_ARCHIVE_KIND } from "../../../src/evolve/apply.js";
import { VERDICT_ARCHIVE_KIND, type L1GateResult } from "../../../src/evolve/gate.js";
import { runEvolveJob } from "../../../src/evolve/jobRun.js";
import { LESSON_ARCHIVE_KIND } from "../../../src/evolve/lesson.js";
import {
  decideProposal,
  readPendingRecords,
  safeProposalFileName,
} from "../../../src/evolve/pending.js";
import { appendSignalLine, signalFilePath } from "../../../src/evolve/recorder.js";
import { JOB_RUN_KIND, PROPOSAL_ARCHIVE_KIND } from "../../../src/evolve/trigger.js";
import type { Proposal, Signal } from "../../../src/evolve/types.js";
import { writeEvolveLevelPolicy } from "../../../src/host/index.js";
import { scratchHome, seedAgentPresence, seedCanonical } from "../../helpers/home.js";

const FIXED_TS = Date.parse("2026-10-26T12:00:00Z");

interface Fixture {
  home: string;
  workspace: string;
  brokenToml: string;
  globalFiles: string[];
  globalBefore: string[];
}

function seedFixture(prefix: string, level: "propose" | "auto-A" | "observe"): Fixture {
  const home = scratchHome(prefix);
  seedAgentPresence(home, ["claude-code", "codex"]);
  seedCanonical(home, {
    managed: ["claude-code", "codex"],
    instructions: "# instructions\n",
    serversYaml: "servers: {}\n",
  });
  const workspace = mkdtempSync(join(tmpdir(), "trellis-jobrun-ws-"));
  mkdirSync(join(workspace, ".codex"), { recursive: true });
  const brokenToml = join(workspace, ".codex", "config.toml");
  writeFileSync(brokenToml, "x = [unclosed\n");
  writeEvolveLevelPolicy(home, { defaultLevel: level, agents: {}, workspaces: {} });
  const globalFiles = [
    join(home, ".trellis", "managed.yaml"),
    join(home, ".trellis", "agents.md"),
    join(home, ".trellis", "mcp", "servers.yaml"),
    join(home, ".claude.json"),
    join(home, ".codex", "config.toml"),
  ];
  return { home, workspace, brokenToml, globalFiles, globalBefore: globalFiles.map((p) => readFileSync(p, "utf-8")) };
}

function toolCallSignal(layer: Signal["layer"]): Signal {
  return {
    kind: "tool-call",
    source: "gateway-event",
    stableId: null,
    collectedAt: FIXED_TS - 10,
    layer,
    ts: FIXED_TS - 10,
    agent: "codex",
    session: "sess-job",
    provider: "trellis",
    tool: "skills_read",
    durationMs: 1,
    result: "ok",
  };
}

test("作业体流水:发现 → rule-based 提案 → Class B pending → 带外批准 → 应用 → lesson", async () => {
  const fx = seedFixture("jobrun-e2e", "propose");
  // 层归属由会话开始事件的 workspace root 派生(recorder 语义)——
  // workspace 进入发现面靠这条信号,不再手工传 root。
  appendSignalLine(
    signalFilePath(fx.home, FIXED_TS),
    toolCallSignal({ kind: "workspace", root: fx.workspace }),
  );

  // ── 第一次运行:产提案(Class B 呈现待批,不写目标文件)──────────────
  const run1 = await runEvolveJob(fx.home, { now: () => FIXED_TS, applyAgents: [] });
  assert.equal(run1.signalsConsidered, 1);
  assert.equal(run1.draftCount, 1, `skipped=${JSON.stringify(run1.skippedNotes)} discarded=${JSON.stringify(run1.discarded)}`);
  assert.equal(run1.enqueuedIds.length, 1);
  assert.equal(run1.autoAdoptedIds.length, 0);
  assert.equal(run1.applied.runId, null);

  const pending = readPendingRecords(fx.home);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.status, "pending");
  assert.equal(pending[0]!.riskClass, "B");
  assert.equal(pending[0]!.proposal.layer.kind, "workspace");
  assert.equal(pending[0]!.proposal.target, fx.brokenToml);

  const kinds1 = new Set(readArchiveRecords(fx.home).map((e) => e.kind));
  assert.ok(kinds1.has(VERDICT_ARCHIVE_KIND), "verdict 档案");
  assert.ok(kinds1.has(PROPOSAL_ARCHIVE_KIND), "proposal 档案(预算计数用)");
  assert.doesNotMatch(readFileSync(fx.brokenToml, "utf-8"), /^# /m, "pending 阶段不写目标");
  fx.globalFiles.forEach((path, i) => {
    assert.equal(readFileSync(path, "utf-8"), fx.globalBefore[i], `全局层被改动: ${path}`);
  });

  // ── 带外批准(管理面 API 直调;TTY 门在命令层)────────────────────────
  const id = run1.enqueuedIds[0]!;
  assert.equal(decideProposal({ homeDir: fx.home, id, decision: "approved", now: () => FIXED_TS }).ok, true);

  // ── 第二次运行:应用阶段(单备份会话)+ lesson ────────────────────────
  const run2 = await runEvolveJob(fx.home, { now: () => FIXED_TS, applyAgents: [] });
  assert.deepEqual(run2.applied.appliedProposalIds, [id]);
  assert.ok(run2.applied.runId !== null);
  assert.match(readFileSync(fx.brokenToml, "utf-8"), /^# x = \[unclosed/m, "修复生效:失败行被注释");

  const kinds2 = new Set(readArchiveRecords(fx.home).map((e) => e.kind));
  assert.ok(kinds2.has(APPLY_ARCHIVE_KIND), "apply-run 档案");
  assert.ok(kinds2.has(LESSON_ARCHIVE_KIND), "lesson 档案");
  assert.deepEqual(run2.lessonIds, [`lesson-${safeProposalFileName(id)}`]);
  fx.globalFiles.forEach((path, i) => {
    assert.equal(readFileSync(path, "utf-8"), fx.globalBefore[i], `全局层被改动: ${path}`);
  });
});

test("off:作业体零副作用(无档案、无 pending、无状态目录写入)", async () => {
  const home = scratchHome("jobrun-off");
  const summary = await runEvolveJob(home, { now: () => FIXED_TS });
  assert.equal(summary.draftCount, 0);
  assert.equal(summary.signalsConsidered, 0);
  assert.deepEqual(readArchiveRecords(home), []);
  assert.equal(existsSync(join(home, ".trellis", "evolve")), false);
});

test("observe:只采集——作业体不产提案(作业级闸)", async () => {
  const fx = seedFixture("jobrun-observe", "observe");
  appendSignalLine(signalFilePath(fx.home, FIXED_TS), toolCallSignal({ kind: "global" }));
  const summary = await runEvolveJob(fx.home, { now: () => FIXED_TS, applyAgents: [] });
  assert.equal(summary.draftCount, 0);
  assert.deepEqual(readArchiveRecords(fx.home), [], "observe 不落任何档案");
});

test("重复发现不重复产提案:已有提案记录的跳过并记因", async () => {
  const fx = seedFixture("jobrun-dedup", "propose");
  appendSignalLine(
    signalFilePath(fx.home, FIXED_TS),
    toolCallSignal({ kind: "workspace", root: fx.workspace }),
  );
  const run1 = await runEvolveJob(fx.home, { now: () => FIXED_TS, applyAgents: [] });
  assert.equal(run1.enqueuedIds.length, 1);
  const run2 = await runEvolveJob(fx.home, { now: () => FIXED_TS + 1, applyAgents: [] });
  assert.equal(run2.draftCount, 1);
  assert.equal(run2.enqueuedIds.length + run2.autoAdoptedIds.length, 0);
  assert.ok(
    run2.skippedNotes.some((note) => note.includes("已有提案记录")),
    `skipped=${JSON.stringify(run2.skippedNotes)}`,
  );
  assert.equal(readPendingRecords(fx.home).length, 1);
});

test("auto-A:Class A 闸通过 → 自动采纳并通知,应用 + lesson", async () => {
  const fx = seedFixture("jobrun-autoa", "auto-A");
  const target = join(fx.home, ".claude.json");
  const findingId = "doctor:drift:-:fixture-a";
  const draft: Proposal = {
    id: "rule-autoa-1",
    createdAt: FIXED_TS,
    kind: "sync-config-fix",
    target,
    layer: { kind: "global" },
    evidence: [{ kind: "doctor-finding", findingId, layer: { kind: "global" } }],
    riskClass: "B", // 自报值不采信;分类器重算应得 A。
    summary: "修复 agent 原生投递面 drift(.claude.json)",
    edits: [{ op: "write-file", path: target, content: "{}\n" }],
  };
  const acceptable: L1GateResult = {
    decision: "acceptable",
    reason: "注入闸:目标条目消除且无新条目",
    domain: "config",
    verdict: { status: "ok", layer: { kind: "global" }, baseline: [], candidate: [] },
    targetIds: [findingId],
    introduced: [],
    resolvedIds: [findingId],
  };

  const run = await runEvolveJob(fx.home, {
    now: () => FIXED_TS,
    applyAgents: [],
    proposeFn: () => [draft],
    evaluateL1Fn: async () => acceptable,
  });

  assert.deepEqual(run.autoAdoptedIds, ["rule-autoa-1"]);
  assert.deepEqual(run.enqueuedIds, []);
  assert.equal(run.notices.length, 1);
  assert.match(run.notices[0]!, /自动采纳 Class A 提案 rule-autoa-1/);
  assert.match(run.notices[0]!, /回滚:/);

  const records = readPendingRecords(fx.home);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.status, "approved", "auto-A 自动采纳=入队并批准");
  assert.equal(records[0]!.riskClass, "A", "自报 B 被重算为 A");

  assert.deepEqual(run.applied.appliedProposalIds, ["rule-autoa-1"]);
  assert.equal(readFileSync(target, "utf-8"), "{}\n");
  const kinds = new Set(readArchiveRecords(fx.home).map((e) => e.kind));
  assert.ok(kinds.has(APPLY_ARCHIVE_KIND));
  assert.ok(kinds.has(LESSON_ARCHIVE_KIND));
});

test("目标层级别 observe:草稿不产出(更具体覆盖)", async () => {
  const fx = seedFixture("jobrun-ws-observe", "propose");
  // 把 workspace 覆盖为 observe:草稿目标层是该 workspace → 不产出。
  writeEvolveLevelPolicy(fx.home, {
    defaultLevel: "propose",
    agents: {},
    workspaces: { [fx.workspace]: "observe" },
  });
  const run = await runEvolveJob(fx.home, { now: () => FIXED_TS, applyAgents: [] });
  assert.equal(run.draftCount, 1);
  assert.equal(run.enqueuedIds.length + run.autoAdoptedIds.length, 0);
  assert.ok(run.skippedNotes.some((note) => note.includes("不产出提案")), JSON.stringify(run.skippedNotes));
  assert.deepEqual(readPendingRecords(fx.home), []);
});

test("可选源缺席记入摘要(agent-bridge unavailable),运行照常", async () => {
  const fx = seedFixture("jobrun-optsrc", "propose");
  const run = await runEvolveJob(fx.home, { now: () => FIXED_TS, applyAgents: [] });
  assert.deepEqual(
    run.optionalSources.map((s) => [s.source, s.status]),
    [["agent-bridge", "unavailable"]],
  );
});

test("信号水位线:作业运行期间到达的信号下次仍被消费", async () => {
  const fx = seedFixture("jobrun-watermark", "propose");
  appendSignalLine(signalFilePath(fx.home, FIXED_TS), toolCallSignal({ kind: "workspace", root: fx.workspace }));
  const run1 = await runEvolveJob(fx.home, { now: () => FIXED_TS, applyAgents: [] });
  assert.equal(run1.signalsMergedAtMs, FIXED_TS);
  // jobMain 落档形态:合并时刻 FIXED_TS,结束时刻 +1000(长作业)。
  appendArchiveRecord(
    fx.home,
    {
      kind: JOB_RUN_KIND,
      payload: { pid: 1, startedAtMs: FIXED_TS, endedAtMs: FIXED_TS + 1000, signalsMergedAtMs: run1.signalsMergedAtMs },
    },
    () => new Date(FIXED_TS + 1000),
  );
  // 作业运行期间到达的信号:collectedAt ∈ (FIXED_TS, FIXED_TS + 1000]。
  const duringJob: Signal = { ...toolCallSignal({ kind: "global" }), collectedAt: FIXED_TS + 500, ts: FIXED_TS + 500 };
  appendSignalLine(signalFilePath(fx.home, FIXED_TS + 400), duringJob);

  const run2 = await runEvolveJob(fx.home, { now: () => FIXED_TS + 2000, applyAgents: [] });
  assert.equal(run2.signalsConsidered, 1, "collectedAt=+500 的信号不得被 endedAtMs=+1000 吞掉");
});
