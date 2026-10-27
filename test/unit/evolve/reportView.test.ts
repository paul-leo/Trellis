/**
 * 进化可视化聚合层(trellis-evolve-visualization 任务 1.1–1.3)。
 *
 * 对应 spec 场景:完整链呈现 / 中途终止的链如实呈现 / 趋势可重算 /
 * 无任何运行时空态 / 可视化是只读消费。全部在 scratch HOME 上进行。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { appendArchiveRecord, readArchiveRecords } from "../../../src/evolve/archive.js";
import { VERDICT_ARCHIVE_KIND } from "../../../src/evolve/gate.js";
import { LESSON_ARCHIVE_KIND } from "../../../src/evolve/lesson.js";
import { decideProposal, enqueueProposal, safeProposalFileName } from "../../../src/evolve/pending.js";
import { buildEvolveReport, type ProposalTrace } from "../../../src/evolve/reportView.js";
import { JOB_RUN_KIND, PROPOSAL_ARCHIVE_KIND, TRIGGER_DECISION_KIND } from "../../../src/evolve/trigger.js";
import type { Lesson, Proposal } from "../../../src/evolve/types.js";
import { writeEvolveLevelPolicy } from "../../../src/host/index.js";
import { scratchHome } from "../../helpers/home.js";

const TS = Date.parse("2026-10-27T12:00:00Z");

const scratches: string[] = [];
function home(prefix: string): string {
  const dir = scratchHome(prefix);
  scratches.push(dir);
  return dir;
}
after(() => {
  while (scratches.length > 0) {
    const dir = scratches.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function proposal(id: string): Proposal {
  return {
    id,
    createdAt: TS,
    kind: "workspace-config-fix",
    target: "/tmp/ws/.codex/config.toml",
    layer: { kind: "workspace", root: "/tmp/ws" },
    evidence: [{ kind: "doctor-finding", findingId: `doctor:workspace-toml-invalid:${id}` }],
    riskClass: "B",
    summary: `修复 ${id}`,
    edits: [{ op: "write-file", path: "/tmp/ws/.codex/config.toml", content: "# bad = [\n" }],
  };
}

function addVerdict(h: string, id: string, targetIds: string[], resolvedIds: string[], introduced: string[] = []): void {
  appendArchiveRecord(
    h,
    {
      kind: VERDICT_ARCHIVE_KIND,
      payload: {
        proposalId: id,
        kind: "workspace-config-fix",
        domain: "config",
        decision: "acceptable",
        reason: "目标条目消除且无新条目",
        status: "ok",
        layer: { kind: "workspace", root: "/tmp/ws" },
        targetIds,
        introduced,
        resolvedIds,
        baseline: [],
        candidate: [],
      },
    },
    () => new Date(TS),
  );
}

function digest(h: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        hash.update(`dir:${path}\n`);
        walk(path);
      } else {
        hash.update(`file:${path}:${createHash("sha256").update(readFileSync(path)).digest("hex")}\n`);
      }
    }
  };
  walk(h);
  return hash.digest("hex");
}

describe("进化可视化聚合层", () => {
  it("完整链呈现:发现→提案→verdict→决策→应用→lesson,含备份会话标识", () => {
    const h = home("report-complete-");
    const id = "rule-doctor-ws-a";
    enqueueProposal({ homeDir: h, proposal: proposal(id), riskClass: "B", riskRuleId: "workspace-config-fix/any" });
    appendArchiveRecord(h, { kind: PROPOSAL_ARCHIVE_KIND, payload: { proposalId: id, riskClass: "B", riskRuleId: "workspace-config-fix/any" } }, () => new Date(TS));
    addVerdict(h, id, ["doctor:workspace-toml-invalid:ws-a"], ["doctor:workspace-toml-invalid:ws-a"]);
    assert.equal(decideProposal({ homeDir: h, id, decision: "approved", now: () => TS }).ok, true);
    appendArchiveRecord(h, { kind: "apply-run", payload: { runId: "run-1", proposalIds: [id] } }, () => new Date(TS + 1));
    // 手动落 lesson 档案(固定时间戳;lesson 写入语义在 lesson.test.ts 覆盖)。
    appendArchiveRecord(
      h,
      {
        kind: LESSON_ARCHIVE_KIND,
        payload: {
          id: `lesson-${safeProposalFileName(id)}`,
          createdAt: TS + 2,
          cue: "修复 workspace toml",
          body: "已应用",
          evidence: [],
          layer: { kind: "workspace", root: "/tmp/ws" },
        } satisfies Lesson,
      },
      () => new Date(TS + 2),
    );

    const report = buildEvolveReport(h);
    assert.equal(report.state, "active");
    const trace = report.timeline.find((t) => t.id === id);
    assert.ok(trace !== undefined, `timeline=${JSON.stringify(report.timeline)}`);
    assert.equal(trace.status, "applied");
    assert.deepEqual(trace.chain.map((step) => step.stage), ["proposed", "verdict", "decision", "applied", "lesson"]);
    assert.equal(trace.backupRunId, "run-1", "应用环节可见备份会话标识(可据此回滚)");
    assert.equal(trace.lessonId, `lesson-${safeProposalFileName(id)}`);
    // 前后测量:目标 finding 消除。
    assert.deepEqual(trace.measurement?.resolvedIds, ["doctor:workspace-toml-invalid:ws-a"]);
    assert.deepEqual(trace.measurement?.introduced, []);
    assert.equal(trace.edits.length, 1);
  });

  it("生效说明入档可回放:apply-run 的 effects 进入时间线;旧档案无字段如实跳过", () => {
    const h = home("report-effects-");
    const id = "rule-effects";
    enqueueProposal({ homeDir: h, proposal: proposal(id), riskClass: "B", riskRuleId: "r" });
    appendArchiveRecord(h, { kind: PROPOSAL_ARCHIVE_KIND, payload: { proposalId: id, riskClass: "B", riskRuleId: "r" } }, () => new Date(TS));
    assert.equal(decideProposal({ homeDir: h, id, decision: "approved", now: () => TS }).ok, true);
    appendArchiveRecord(
      h,
      {
        kind: "apply-run",
        payload: {
          runId: "run-fx",
          proposalIds: [id],
          effects: [
            { agent: "claude-code", observation: "doctor-only", effect: "已触发渲染同步(exit 0),同步完成后生效" },
            { agent: "kimi-code", observation: "events", effect: "后续会话读取 canonical 时自然生效(runtime 投递,无需同步)" },
          ],
          syncExitCode: 0,
        },
      },
      () => new Date(TS + 1),
    );

    const trace = buildEvolveReport(h).timeline.find((t) => t.id === id);
    assert.ok(trace !== undefined);
    const effectNotes = trace.chain.filter((step) => step.note.startsWith("生效时点"));
    assert.equal(effectNotes.length, 2);
    assert.match(effectNotes[0]!.note, /claude-code:已触发渲染同步/);
    assert.match(effectNotes[1]!.note, /kimi-code:后续会话读取/);
  });

  it("approved 未应用计数:已批准未应用计入,应用后清零", () => {
    const h = home("report-unapplied-");
    const id = "rule-unapplied";
    enqueueProposal({ homeDir: h, proposal: proposal(id), riskClass: "B", riskRuleId: "r" });
    appendArchiveRecord(h, { kind: PROPOSAL_ARCHIVE_KIND, payload: { proposalId: id, riskClass: "B", riskRuleId: "r" } }, () => new Date(TS));
    assert.equal(decideProposal({ homeDir: h, id, decision: "approved", now: () => TS }).ok, true);
    assert.equal(buildEvolveReport(h).counts.approvedUnapplied, 1);

    appendArchiveRecord(h, { kind: "apply-run", payload: { runId: "run-u", proposalIds: [id] } }, () => new Date(TS + 1));
    assert.equal(buildEvolveReport(h).counts.approvedUnapplied, 0);
  });

  it("中途终止的链如实呈现:L1 丢弃只到 verdict/丢弃环,不伪造后续", () => {
    const h = home("report-truncated-");
    appendArchiveRecord(
      h,
      {
        kind: "proposal-reject",
        payload: {
          proposalId: "rule-bad",
          phase: "initial",
          code: "no-evidence",
          reason: "提案没有任何证据链接",
          retried: false,
          issues: [],
        },
      },
      () => new Date(TS),
    );

    const report = buildEvolveReport(h);
    const trace = report.timeline.find((t) => t.id === "rule-bad");
    assert.ok(trace !== undefined);
    assert.equal(trace.status, "discarded");
    assert.deepEqual(trace.chain.map((step) => step.stage), ["discarded"]);
    assert.match(trace.chain[0]!.note, /no-evidence/);
    assert.equal(trace.measurement, null);
    assert.equal(trace.backupRunId, null);
    assert.equal(trace.lessonId, null);
  });

  it("无测量记录:没有 verdict 档案的提案 measurement 为 null(不推断)", () => {
    const h = home("report-nomeasure-");
    const id = "rule-nomeasure";
    enqueueProposal({ homeDir: h, proposal: proposal(id), riskClass: "B", riskRuleId: "workspace-config-fix/any" });
    appendArchiveRecord(h, { kind: PROPOSAL_ARCHIVE_KIND, payload: { proposalId: id, riskClass: "B", riskRuleId: "workspace-config-fix/any" } }, () => new Date(TS));

    const trace = buildEvolveReport(h).timeline.find((t) => t.id === id);
    assert.ok(trace !== undefined);
    assert.equal(trace.status, "pending");
    assert.equal(trace.measurement, null);
  });

  it("趋势可重算:数值与档案手工计数一致,每条带口径;无合成评分键", () => {
    const h = home("report-trends-");
    addVerdict(h, "p1", ["f1"], ["f1"]);
    addVerdict(h, "p2", ["f2"], ["f2"]);
    addVerdict(h, "p3", ["f3"], []); // 未消除
    enqueueProposal({ homeDir: h, proposal: proposal("p1"), riskClass: "B", riskRuleId: "r" });
    enqueueProposal({ homeDir: h, proposal: proposal("p2"), riskClass: "B", riskRuleId: "r" });
    assert.equal(decideProposal({ homeDir: h, id: "p1", decision: "approved", now: () => TS }).ok, true);
    assert.equal(decideProposal({ homeDir: h, id: "p2", decision: "rejected", now: () => TS }).ok, true);
    appendArchiveRecord(h, { kind: JOB_RUN_KIND, payload: { pid: 1, startedAtMs: TS, endedAtMs: TS + 10, summary: { signalsConsidered: 2, enqueuedIds: ["p1"], autoAdoptedIds: [] } } }, () => new Date(TS + 10));
    appendArchiveRecord(h, { kind: JOB_RUN_KIND, payload: { pid: 2, startedAtMs: TS + 20, endedAtMs: TS + 30, error: "boom" } }, () => new Date(TS + 30));

    const report = buildEvolveReport(h);
    const byId = new Map(report.trends.map((t) => [t.id, t]));
    assert.equal(byId.get("findings-resolved")!.value, 2, "verdict resolvedIds 累计可重算");
    assert.equal(byId.get("adoption-rate")!.value, 0.5);
    assert.equal(byId.get("rejection-rate")!.value, 0.5);
    assert.equal(byId.get("job-runs")!.value, 2);
    assert.equal(byId.get("job-failures")!.value, 1);
    for (const metric of report.trends) {
      assert.ok(metric.source.length > 0, `${metric.id} 缺口径说明`);
    }
    // 指标诚实性:报告里不存在合成数值评分。
    assert.deepEqual(
      Object.keys(report).sort(),
      ["counts", "jobRuns", "levels", "notices", "state", "timeline", "trends"].sort(),
    );
    for (const key of Object.keys(report)) {
      assert.doesNotMatch(key, /score|health/i, "不合成评分");
    }
  });

  it("空态:从未运行时 state=not-enabled、趋势全 null、不呈现虚构数值", () => {
    const h = home("report-empty-");
    const report = buildEvolveReport(h);
    assert.equal(report.state, "not-enabled");
    assert.deepEqual(report.timeline, []);
    for (const metric of report.trends) assert.equal(metric.value, null, metric.id);
    assert.deepEqual(report.jobRuns, []);
  });

  it("只读零副作用:聚合前后状态目录逐字节不变", () => {
    const h = home("report-readonly-");
    writeEvolveLevelPolicy(h, { defaultLevel: "propose", agents: {}, workspaces: {} });
    const id = "rule-readonly";
    enqueueProposal({ homeDir: h, proposal: proposal(id), riskClass: "B", riskRuleId: "r" });
    appendArchiveRecord(h, { kind: PROPOSAL_ARCHIVE_KIND, payload: { proposalId: id, riskClass: "B", riskRuleId: "r" } }, () => new Date(TS));
    const before = digest(h);

    buildEvolveReport(h);
    buildEvolveReport(h);

    assert.equal(digest(h), before, "聚合是纯读:任何文件内容/目录结构不得变化");
  });

  it("enabled-idle:开了级别但从未运行,有级别无活动", () => {
    const h = home("report-idle-");
    writeEvolveLevelPolicy(h, { defaultLevel: "observe", agents: {}, workspaces: {} });
    const report = buildEvolveReport(h);
    assert.equal(report.state, "enabled-idle");
    assert.equal(report.levels.defaultLevel, "observe");
  });
});
