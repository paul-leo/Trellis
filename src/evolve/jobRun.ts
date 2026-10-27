/**
 * 一次性作业的作业体(trellis-evolve 任务 11.5 括注"作业即运行移植引擎";
 * 14.1 fixture E2E 的流水在此落地为生产入口)。
 *
 * 流水(顺序即依赖,与 fixtureE2e 同链):
 *   0. 级别闸:没有任何 propose/auto-A 设置 → 零副作用返回(触发器只在
 *      propose+ 拉起;这里是直接 spawn 的防御)。
 *   1. 可选源探测(11.3):agent-bridge 缺席记 unavailable,不失败。
 *   2. 信号合并(自上次作业的信号合并时刻以来;首次为全部,11.5"未
 *      消费"语义)。
 *   3. 检查发现:全局 + 信号层归属出现过/级别策略声明过的 workspace,
 *      各自 `runChecks`(L1 的 doctor oracle)。观察面即发现面——只有
 *      进过信号/策略的 workspace 会被扫描(与"信号是观察记录"一致)。
 *   4. 提案草稿:rule-based 通道——`proposeFromSignals` 的信号对齐路径
 *      ∪ 当前发现直接 `ruleBasedProposal`(同一内核、提案 id 同源
 *      `rule-<findingId>` 天然去重;已入 pending 的跳过)。editor/spawn
 *      通道(design D7)在 `runDelegatedCall` 就绪前不在作业里拉真实
 *      CLI 会话,见 `ProposalChannelAvailability` 注释。
 *   5. 逐草稿治理:域分派(配置类才进通道)→ 机械校验(无 editor 不
 *      重试)→ L1 前闸(verdict 差集,唯一 verdict)→ 风险分类(不采信
 *      自报)→ 采纳门(A 仅 auto-A 且闸通过自动采纳并通知;B 永远待批)。
 *      草稿的提案/采纳级别按其目标层解析(workspace > default;agent
 *      粒度只闸观察与触发,不进提案产出——提案的来源 agent 不可考,
 *      发现是 doctor 检查面而非 agent 行为)。
 *   6. 应用阶段(12.5):全部已批准未应用的编辑在同一备份会话写入;
 *      按 delivery 分类对原生渲染 agent 触发同步(host 门面 `triggerRenderSync`)。
 *   7. lesson(12.6):本次应用的每条提案蒸馏一条 lesson;记忆启用走
 *      记忆管道,否则只留档案(skipped 不是 failed)。
 *
 * 每步都只经 `src/host/*` 门面与本目录模块(边界 10.3);无模型调用、
 * 不 spawn 真实 agent CLI。摘要返回给 jobMain 并入 job-run 档案。
 */

import type { CheckEntry, RunChecksOptions, SurfaceLayer } from "../host/index.js";
import {
  classifyManagedObservation,
  isMemoryDeliveryEnabled,
  loadEvolveLevelPolicy,
  resolveEvolveLevel,
  runChecks,
  triggerRenderSync,
  type EvolveLevelPolicy,
  type Level,
} from "../host/index.js";
import { appendArchiveRecord, readArchiveRecords } from "./archive.js";
import { applyApprovedProposals, type ApplyAgent, type ApplyApprovedResult } from "./apply.js";
import { dispatchProposalDomain, evaluateL1Proposal, type EvaluateL1Options, type L1GateResult } from "./gate.js";
import { recordLesson } from "./lesson.js";
import {
  decideProposal,
  enqueueProposal,
  readPendingRecord,
  readPendingRecords,
  safeProposalFileName,
} from "./pending.js";
import { proposeFromSignals, ruleBasedProposal } from "./propose.js";
import { readAllSignals } from "./recorder.js";
import { classifyProposalRisk, evaluateAdoptionGate } from "./risk.js";
import { probeAgentBridgeSource, type OptionalSourceProbe } from "./sources.js";
import {
  PROPOSAL_ARCHIVE_KIND,
  lastSignalWatermarkMs,
} from "./trigger.js";
import type { Lesson, Proposal, Signal } from "./types.js";
import { validateProposalWithRetry } from "./validate.js";

/** 草稿来源的输入面(proposeFn 注入缝的契约)。 */
export interface ProposeInput {
  readonly homeDir: string;
  readonly signals: readonly Signal[];
  readonly findings: readonly CheckEntry[];
  readonly now: () => number;
}

export interface RunEvolveJobOptions {
  /** 时间源(毫秒);缺省 Date.now(测试注入固定时钟)。 */
  readonly now?: () => number;
  /** 草稿来源注入缝(测试直达治理层);缺省 rule-based 通道组装。 */
  readonly proposeFn?: (input: ProposeInput) => readonly Proposal[];
  /** L1 前闸注入缝(与 `EvaluateL1Options` 自带缝同风格);缺省真实闸。 */
  readonly evaluateL1Fn?: (options: EvaluateL1Options) => Promise<L1GateResult>;
  /** 应用阶段的 agent 分类(测试传空避开真实同步);缺省按 delivery 分类。 */
  readonly applyAgents?: readonly ApplyAgent[];
  /** 原生渲染同步触发缝;缺省 host `triggerRenderSync`。 */
  readonly triggerSync?: () => Promise<{ exitCode: number }>;
}

export interface EvolveJobSummary {
  readonly signalsConsidered: number;
  readonly findingsConsidered: number;
  readonly draftCount: number;
  readonly enqueuedIds: string[];
  readonly autoAdoptedIds: string[];
  readonly discarded: readonly { readonly id: string; readonly code: string; readonly reason: string }[];
  readonly skippedNotes: readonly string[];
  readonly applied: {
    readonly runId: string | null;
    readonly appliedProposalIds: readonly string[];
    readonly syncExitCode: number | null;
  };
  readonly lessonIds: string[];
  readonly notices: string[];
  readonly optionalSources: readonly OptionalSourceProbe[];
  /** 信号合并时刻(步骤 2 的 now());job-run 档案据此推进消费水位线,
   * 作业运行期间到达的信号下次仍被消费。级别闸早退为 null(未合并)。 */
  readonly signalsMergedAtMs: number | null;
}

/** 作业级闸:任一粒度出现 propose/auto-A 才值得运行(observe 只采集)。 */
function anyProposalLevel(policy: EvolveLevelPolicy): boolean {
  const levels: (Level | undefined)[] = [
    policy.defaultLevel,
    ...Object.values(policy.agents),
    ...Object.values(policy.workspaces),
  ];
  return levels.some((level) => level === "propose" || level === "auto-A");
}

/** 草稿目标层的生效级别(workspace > agent > default > off)。 */
function draftLevel(policy: EvolveLevelPolicy, layer: SurfaceLayer): Level {
  return resolveEvolveLevel(policy, layer.kind === "workspace" ? { workspaceRoot: layer.root } : {});
}

/** 缺省草稿组装:信号对齐 ∪ 当前发现直提,id 同源去重。 */
function defaultPropose(input: ProposeInput): Proposal[] {
  // editor/spawn 通道就绪前,生产走 rule-based 兜底(design D7:委派不可
  // 用时 doctor finding 形态信号走 rule-based)。ruleBasedProposal 是
  // proposeFromSignals 的同一内核;这里补上"无对齐信号但发现仍在"的条目
  // ——发现由作业的 runChecks 观察(9.4①:doctor/sync 检查即原生渲染
  // agent 的信号来源),生产信号面里事件信号 stableId 恒为 null。
  const loop = proposeFromSignals({
    signals: input.signals,
    findings: input.findings,
    availability: { delegate: false, spawn: false },
    now: input.now,
  });
  const drafts: Proposal[] = [...loop.proposals];
  const covered = new Set(drafts.map((draft) => draft.id));
  for (const entry of input.findings) {
    const draft = ruleBasedProposal(entry, { now: input.now });
    if (draft === null || covered.has(draft.id)) continue;
    covered.add(draft.id);
    drafts.push(draft);
  }
  return drafts;
}

/** 上一作业的信号水位线(优先"信号合并时刻",旧档案回退 endedAtMs);
 * 从未跑过为 null。 */
function lastSignalWatermark(homeDir: string): number | null {
  return lastSignalWatermarkMs(readArchiveRecords(homeDir));
}

export async function runEvolveJob(
  homeDir: string,
  options: RunEvolveJobOptions = {},
): Promise<EvolveJobSummary> {
  const now = options.now ?? Date.now;
  const empty: EvolveJobSummary = {
    signalsConsidered: 0,
    findingsConsidered: 0,
    draftCount: 0,
    enqueuedIds: [],
    autoAdoptedIds: [],
    discarded: [],
    skippedNotes: [],
    applied: { runId: null, appliedProposalIds: [], syncExitCode: null },
    lessonIds: [],
    notices: [],
    optionalSources: [],
    signalsMergedAtMs: null,
  };

  // ── 0. 级别闸 ─────────────────────────────────────────────────────────
  const policy = loadEvolveLevelPolicy(homeDir);
  if (!anyProposalLevel(policy)) return empty;

  // ── 1. 可选源探测(缺席合法,记状态不失败)────────────────────────────
  const optionalSources = [probeAgentBridgeSource(homeDir)];

  // ── 2. 信号合并(自上次作业的信号水位线以来)────────────────────────
  const signalsMergedAtMs = now();
  const signals = readAllSignals(homeDir, lastSignalWatermark(homeDir));

  // ── 3. 检查发现(全局 + 观察面内的 workspace)────────────────────────
  const workspaceRoots = new Set<string>();
  for (const signal of signals) {
    if (signal.layer.kind === "workspace") workspaceRoots.add(signal.layer.root);
  }
  for (const root of Object.keys(policy.workspaces)) workspaceRoots.add(root);
  const findingsById = new Map<string, CheckEntry>();
  const runOne = async (runOptions: RunChecksOptions): Promise<void> => {
    const result = await runChecks(runOptions);
    for (const entry of result.entries) findingsById.set(entry.id, entry);
  };
  await runOne({ homeDir });
  for (const root of workspaceRoots) await runOne({ homeDir, workspaceRoot: root });
  const findings = [...findingsById.values()];

  // ── 4. 提案草稿 ───────────────────────────────────────────────────────
  const proposeFn = options.proposeFn ?? defaultPropose;
  const drafts = proposeFn({ homeDir, signals, findings, now });

  // ── 5. 逐草稿治理 ─────────────────────────────────────────────────────
  const enqueuedIds: string[] = [];
  const autoAdoptedIds: string[] = [];
  const discarded: { id: string; code: string; reason: string }[] = [];
  const skippedNotes: string[] = [];
  const notices: string[] = [];
  const known = new Set(readPendingRecords(homeDir).map((record) => record.id));

  for (const draft of drafts) {
    if (known.has(draft.id)) {
      skippedNotes.push(`${draft.id}:已有提案记录,不重复产出`);
      continue;
    }
    const level = draftLevel(policy, draft.layer);
    if (level !== "propose" && level !== "auto-A") {
      skippedNotes.push(`${draft.id}:目标层级别 ${level},不产出提案`);
      continue;
    }
    const domain = dispatchProposalDomain(draft.kind);
    if (!domain.entersProposalChannel) {
      skippedNotes.push(`${draft.id}:${domain.note}`);
      continue;
    }
    const validated = await validateProposalWithRetry({ homeDir, proposal: draft, now });
    if (validated.status === "discarded") {
      discarded.push({ id: draft.id, code: validated.code, reason: validated.reason });
      continue;
    }
    const proposal = validated.proposal;
    const evaluateL1 = options.evaluateL1Fn ?? evaluateL1Proposal;
    const gate = await evaluateL1({
      homeDir,
      workspaceRoot: proposal.layer.kind === "workspace" ? proposal.layer.root : null,
      proposal,
      now,
    });
    const classification = classifyProposalRisk(proposal, {
      homeDir,
      ...(validated.validation.needsExplicitApproval !== undefined
        ? { needsExplicitApproval: validated.validation.needsExplicitApproval }
        : {}),
    });
    const adoption = evaluateAdoptionGate({
      level,
      classification,
      probePassed: gate.decision === "acceptable",
      proposal,
    });
    if (gate.decision !== "acceptable") {
      skippedNotes.push(`${proposal.id}:L1 前闸不可采纳(${gate.reason})`);
      continue;
    }
    enqueueProposal({
      homeDir,
      proposal,
      riskClass: classification.riskClass,
      riskRuleId: classification.ruleId,
      now,
    });
    appendArchiveRecord(
      homeDir,
      {
        kind: PROPOSAL_ARCHIVE_KIND,
        payload: { proposalId: proposal.id, riskClass: classification.riskClass, riskRuleId: classification.ruleId },
      },
      () => new Date(now()),
    );
    known.add(proposal.id);
    if (adoption.action === "auto-adopt") {
      decideProposal({ homeDir, id: proposal.id, decision: "approved", now });
      autoAdoptedIds.push(proposal.id);
      notices.push(adoption.notification.message);
    } else {
      enqueuedIds.push(proposal.id);
    }
  }

  // ── 6. 应用阶段(全部已批准未应用,同一备份会话)──────────────────────
  const agents: readonly ApplyAgent[] =
    options.applyAgents ?? classifyManagedObservation(homeDir).map((entry) => ({
      agent: entry.agent,
      observation: entry.observation,
    }));
  const triggerSync = options.triggerSync ?? (async () => await triggerRenderSync({ homeDir }));
  const applied: ApplyApprovedResult = await applyApprovedProposals({
    homeDir,
    agents,
    triggerSync,
    now: () => new Date(now()),
  });
  for (const id of applied.skippedInvalidIds) {
    skippedNotes.push(`${id}:应用前重校验不通过(pending 磁盘状态漂移?),跳过`);
  }

  // ── 7. lesson(本次应用的每条提案蒸馏一条)───────────────────────────
  const memoryEnabled = isMemoryDeliveryEnabled(homeDir);
  const lessonIds: string[] = [];
  for (const id of applied.appliedProposalIds) {
    const record = readPendingRecord(homeDir, id);
    if (record === null) continue;
    const lesson: Lesson = {
      id: `lesson-${safeProposalFileName(id)}`,
      createdAt: now(),
      cue: record.proposal.summary,
      body:
        `应用阶段已写入备份会话 ${applied.runId ?? "?"}(风险 ${record.riskClass});` +
        `编辑:${record.proposal.edits.map((edit) => `${edit.op} ${edit.path}`).join("; ")}(kind ${record.proposal.kind})。`,
      evidence: record.proposal.evidence,
      layer: record.proposal.layer,
    };
    recordLesson({ homeDir, lesson, memoryEnabled });
    lessonIds.push(lesson.id);
  }

  return {
    signalsConsidered: signals.length,
    findingsConsidered: findings.length,
    draftCount: drafts.length,
    enqueuedIds,
    autoAdoptedIds,
    discarded,
    skippedNotes,
    applied: {
      runId: applied.runId,
      appliedProposalIds: applied.appliedProposalIds,
      syncExitCode: applied.syncExitCode,
    },
    lessonIds,
    notices,
    optionalSources,
    signalsMergedAtMs,
  };
}
