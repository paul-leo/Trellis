/**
 * 应用与生效(trellis-evolve 任务 12.5)。
 *
 * 把**已批准**提案的全部编辑写入托管备份会话的同一会话内
 * (spec"原子运行与回滚":一次运行的全部写入在同一备份会话,一次回滚
 * 恢复运行前状态),并把备份会话标识记入运行档案(kind `apply-run`)。
 *
 * 采纳后的生效边界(spec"采纳的生效边界"):
 *   - runtime 投递("events")的 agent:后续会话读取 canonical 时自然
 *     生效,无需同步(9.4 定案:runtime provider 每请求实时读盘);
 *   - 仅原生渲染("doctor-only")的 agent:触发渲染同步,报告同步结果。
 *
 * 同步经注入缝触发:`triggerSync` 由管理面/作业层注入 `runSync` 包装
 * (消费者边界 10.3:本目录不 import `commands/*`),测试注入桩。缺省
 * 未注入时只报告生效时点,不假装同步已经发生。
 *
 * 已应用查重以档案为准(apply-run 的 proposalIds):重复调用跳过,
 * 不开第二个会话;部分失败的 HostEditError 批次照记档案(failed 标记,
 * 不计入查重),提案不标已应用,重试重放(编辑幂等:write-file 整文件
 * 写,remove-symlink 对已不存在目标视为成功)。
 *
 * 生效时点说明(effects)与同步结果随 apply-run 档案入档(trellis-
 * evolve-review-fixes:此前算完即弃,报告不可回放)。同步触发失败收口
 * 为效果文本并入档,不丢应用档案——编辑已写入,同步可人工补。
 */

import { appendArchiveRecord, readArchiveRecords } from "./archive.js";
import { readProposalsByStatus } from "./pending.js";
import { validateProposal } from "./validate.js";
import { applyEdits, HostEditError, type EditOp } from "../host/index.js";

/** 运行档案 kind:一次应用运行(含备份会话标识与提案集合)。 */
export const APPLY_ARCHIVE_KIND = "apply-run";

/** 与 host/levels 的 EvolveObservation 同语义:由调用方按 delivery
 * 分类注入("events" = runtime 交付;"doctor-only" = 仅原生渲染)。 */
export type ApplyObservation = "events" | "doctor-only";

export interface ApplyAgent {
  readonly agent: string;
  readonly observation: ApplyObservation;
}

export interface AgentEffectiveness {
  readonly agent: string;
  readonly observation: ApplyObservation;
  /** 人类可读的生效时点说明(应用后向用户展示)。 */
  readonly effect: string;
}

export interface ApplyApprovedOptions {
  readonly homeDir: string;
  /** 托管 agent 及其交付形态;缺省空(只应用,不逐 agent 说明)。 */
  readonly agents?: readonly ApplyAgent[];
  /** 原生渲染 agent 的同步触发注入缝;存在 doctor-only agent 且本次
   * 有编辑被应用时调用一次。返回值的 exitCode 进入结果与生效说明。 */
  readonly triggerSync?: () => Promise<{ exitCode: number }>;
  /** 时间源;缺省 Date.now(仅透传档案打戳用,档案自带 now 缺省)。 */
  readonly now?: () => Date;
}

export interface ApplyApprovedResult {
  /** 本次备份会话标识;无未应用的已批准提案时 null(不开会话)。 */
  readonly runId: string | null;
  readonly appliedProposalIds: string[];
  readonly alreadyAppliedIds: string[];
  readonly effects: AgentEffectiveness[];
  /** 原生渲染同步的退出码;未触发为 null。 */
  readonly syncExitCode: number | null;
  /** 同步触发抛错时的错误文本(收口为效果文本,不中断应用);无为 null。 */
  readonly syncError: string | null;
  /** 应用前重校验不通过而跳过的提案 id(纵深防御,见实现注释)。 */
  readonly skippedInvalidIds: string[];
}

function appliedIdsFromArchive(homeDir: string): Set<string> {
  const applied = new Set<string>();
  for (const entry of readArchiveRecords(homeDir)) {
    if (entry.kind !== APPLY_ARCHIVE_KIND) continue;
    const payload = entry.payload as { proposalIds?: unknown; failed?: unknown } | null;
    // 部分失败的批次(failed)不计入"已应用":重试按幂等重放全部编辑。
    if (payload === null || payload.failed === true || !Array.isArray(payload.proposalIds)) continue;
    for (const id of payload.proposalIds) {
      if (typeof id === "string") applied.add(id);
    }
  }
  return applied;
}

function effectivenessFor(
  agent: ApplyAgent,
  syncExitCode: number | null,
  syncTriggered: boolean,
  syncError: string | null,
): AgentEffectiveness {
  if (agent.observation === "events") {
    return {
      agent: agent.agent,
      observation: agent.observation,
      effect: "后续会话读取 canonical 时自然生效(runtime 投递,无需同步)",
    };
  }
  if (syncTriggered) {
    return {
      agent: agent.agent,
      observation: agent.observation,
      effect: `已触发渲染同步(exit ${String(syncExitCode ?? "?")}),同步完成后生效`,
    };
  }
  if (syncError !== null) {
    return {
      agent: agent.agent,
      observation: agent.observation,
      effect: `触发渲染同步失败:${syncError};需运行 \`trellis sync\` 后生效`,
    };
  }
  return {
    agent: agent.agent,
    observation: agent.observation,
    effect: "需运行 `trellis sync` 后生效(本次未提供同步触发)",
  };
}

/**
 * 应用全部已批准且未应用的提案:编辑合并进**同一个**备份会话写入,
 * 档案记会话标识,再按 agent 交付形态说明生效时点并对原生渲染 agent
 * 触发同步。无事可做时零副作用(不开会话、不触发同步、不写档案)。
 */
export async function applyApprovedProposals(options: ApplyApprovedOptions): Promise<ApplyApprovedResult> {
  const { homeDir } = options;
  const alreadyApplied = appliedIdsFromArchive(homeDir);
  const approved = readProposalsByStatus(homeDir, "approved");

  const appliedProposalIds: string[] = [];
  const alreadyAppliedIds: string[] = [];
  const skippedInvalidIds: string[] = [];
  const edits: EditOp[] = [];
  for (const record of approved) {
    if (alreadyApplied.has(record.id)) {
      alreadyAppliedIds.push(record.id);
      continue;
    }
    // 纵深防御:应用前重跑机械校验。pending 是可变磁盘状态,approve 只
    // 翻 status 字段——入队时的白名单/路径穿越约束在这一步重放,磁盘
    // 漂移或被改写的编辑到不了写入面。
    const validation = validateProposal(record.proposal, { homeDir });
    if (!validation.ok) {
      skippedInvalidIds.push(record.id);
      continue;
    }
    appliedProposalIds.push(record.id);
    for (const edit of record.proposal.edits) edits.push(edit);
  }

  if (appliedProposalIds.length === 0) {
    return {
      runId: null,
      appliedProposalIds: [],
      alreadyAppliedIds,
      effects: [],
      syncExitCode: null,
      syncError: null,
      skippedInvalidIds,
    };
  }

  let runId: string;
  try {
    ({ runId } = await applyEdits({ homeDir, edits, command: "evolve-apply" }));
  } catch (err) {
    if (err instanceof HostEditError) {
      // 部分失败也落 apply-run 档案(failed 不计入已应用查重):runId
      // 可经 `trellis rollback` 撤销已应用部分,审计不留空白。
      appendArchiveRecord(
        homeDir,
        {
          kind: APPLY_ARCHIVE_KIND,
          payload: { runId: err.runId, proposalIds: appliedProposalIds, failed: true, error: err.message },
        },
        options.now ?? (() => new Date()),
      );
    }
    throw err;
  }
  // 生效:原生渲染 agent 触发同步(runtime agent 无需——9.4 实时读取)。
  // 同步失败收口为效果文本(syncError),不丢应用档案:编辑已写入,同步可人工补。
  const agents = options.agents ?? [];
  const needsSync = agents.some((a) => a.observation === "doctor-only");
  let syncExitCode: number | null = null;
  let syncTriggered = false;
  let syncError: string | null = null;
  if (needsSync && options.triggerSync !== undefined) {
    try {
      syncExitCode = (await options.triggerSync()).exitCode;
      syncTriggered = true;
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err);
    }
  }

  const effects = agents.map((agent) => effectivenessFor(agent, syncExitCode, syncTriggered, syncError));
  // 档案记会话标识 + 逐 agent 生效时点 + 同步结果(review-fixes ❌3:此前
  // effects 算完即弃);单条 apply-run 记录承载全部应用元数据,报告回放同源。
  appendArchiveRecord(
    homeDir,
    {
      kind: APPLY_ARCHIVE_KIND,
      payload: {
        runId,
        proposalIds: appliedProposalIds,
        effects,
        syncExitCode,
        ...(syncError !== null ? { syncError } : {}),
      },
    },
    options.now ?? (() => new Date()),
  );

  return { runId, appliedProposalIds, alreadyAppliedIds, effects, syncExitCode, syncError, skippedInvalidIds };
}
