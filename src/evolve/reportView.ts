/**
 * 进化可视化聚合层(trellis-evolve-visualization 任务 1.1)。
 *
 * 单一计算源:从三个只读来源(~/.trellis/evolve/archive/records.jsonl、
 * evolve/pending/*.json、evolve.yaml)聚合出 `EvolveReport`,CLI 的
 * `evolve report` / `status --json` 与 GUI sidecar 路由只是它的渲染/传输
 * 壳——绝不维护第二份独立计算(gui-sidecar-api 的"读视图镜像 CLI"规约)。
 *
 * 只读零副作用:本模块永不 mkdir/append/write;全部指标可从档案重算,
 * 每条趋势指标带口径说明(spec"趋势指标只来自真实测量")。数值评分
 * (0-100 健康分之类)一律不合成——分数轴等 L2 探针任务集落地后另行变更。
 */

import { loadEvolveLevelPolicy, type EditOp, type EvolveLevelPolicy, type Level, type SurfaceLayer } from "../host/index.js";
import { readArchiveRecords, type ArchiveEntry } from "./archive.js";
import { readPendingRecords, safeProposalFileName, type PendingRecord } from "./pending.js";
import type { Lesson } from "./types.js";
import { JOB_RUN_KIND, PROPOSAL_ARCHIVE_KIND, TRIGGER_DECISION_KIND } from "./trigger.js";
import { VERDICT_ARCHIVE_KIND } from "./gate.js";
import { PROPOSAL_DECISION_ARCHIVE_KIND } from "./pending.js";
import { PROPOSAL_REJECT_ARCHIVE_KIND } from "./validate.js";
import { LESSON_ARCHIVE_KIND } from "./lesson.js";

/** 时间线一环:阶段、时间戳(ISO)与可读说明。 */
export interface TimelineStep {
  readonly stage: "proposed" | "discarded" | "verdict" | "decision" | "applied" | "lesson";
  readonly at: string;
  readonly note: string;
}

/** 前后测量(来自 L1 verdict 档案;无 verdict 时为 null,不推断)。 */
export interface ProposalMeasurement {
  readonly decision: string;
  readonly reason: string;
  readonly targetIds: readonly string[];
  readonly resolvedIds: readonly string[];
  readonly introduced: readonly string[];
}

/** 一条提案的全生命周期追踪(缺口如实呈现,不伪造补齐)。 */
export interface ProposalTrace {
  readonly id: string;
  readonly summary: string;
  readonly kind: string;
  readonly riskClass: string | null;
  readonly layer: SurfaceLayer | null;
  /** 终态:discarded(校验/L1 丢弃)/ pending / approved(待应用)/
   *  rejected / applied(已应用)。 */
  readonly status: "discarded" | "pending" | "approved" | "rejected" | "applied";
  readonly chain: readonly TimelineStep[];
  /** 最近一次 L1 测量;整条提案无 verdict 档案时 null。 */
  readonly measurement: ProposalMeasurement | null;
  readonly edits: readonly EditOp[];
  /** 应用时的备份会话标识(可据此回滚);未应用为 null。 */
  readonly backupRunId: string | null;
  /** 蒸馏的 lesson id;无为 null。 */
  readonly lessonId: string | null;
}

/** 趋势指标(全部可从档案重算;口径随数据导出)。 */
export interface TrendMetric {
  readonly id: string;
  readonly label: string;
  /** 数值指标;无测量时 null(GUI 显示"无测量记录"而非 0)。 */
  readonly value: number | null;
  /** 数据口径:由哪类档案记录聚得(可重算依据)。 */
  readonly source: string;
}

/** 一次作业运行(job-run 档案)。 */
export interface JobRunEntry {
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly ok: boolean;
  readonly error: string | null;
  /** 触发来源(run-backfill D1);旧档案无字段视作 `event`。 */
  readonly trigger: "event" | "manual" | "chain";
  readonly summary: {
    readonly signalsConsidered: number | null;
    readonly enqueued: number | null;
    readonly autoAdopted: number | null;
  };
}

/** 可视化状态:未开启 / 已开启未运行 / 有运行历史。 */
export type EvolveViewState = "not-enabled" | "enabled-idle" | "active";

export interface EvolveReport {
  readonly state: EvolveViewState;
  readonly levels: {
    readonly defaultLevel: Level | null;
    readonly agents: Readonly<Record<string, Level>>;
    readonly workspaces: Readonly<Record<string, Level>>;
  };
  readonly counts: {
    readonly pending: number;
    readonly approved: number;
    readonly rejected: number;
    /** 已批准但未应用(可经 `trellis evolve apply` 消化)。 */
    readonly approvedUnapplied: number;
  };
  readonly timeline: readonly ProposalTrace[];
  readonly trends: readonly TrendMetric[];
  readonly jobRuns: readonly JobRunEntry[];
  readonly notices: readonly string[];
}

function isoTime(entry: ArchiveEntry): string {
  return entry.recordedAt;
}

function payloadOf(entry: ArchiveEntry): Record<string, unknown> {
  return (entry.payload ?? {}) as Record<string, unknown>;
}

function levelMap(policy: EvolveLevelPolicy): {
  defaultLevel: Level | null;
  agents: Record<string, Level>;
  workspaces: Record<string, Level>;
} {
  return {
    defaultLevel: policy.defaultLevel ?? null,
    agents: { ...policy.agents },
    workspaces: { ...policy.workspaces },
  };
}

/**
 * 聚合进化报告(纯读)。timeline 按提案 id 关联 proposal / proposal-reject /
 * verdict / proposal-decision / apply-run / lesson 档案;链上缺环如实标注,
 * 不推断补齐。
 */
export function buildEvolveReport(homeDir: string): EvolveReport {
  const entries = readArchiveRecords(homeDir);
  const pending = readPendingRecords(homeDir);
  const policy = loadEvolveLevelPolicy(homeDir);

  // ---- 提案追踪(以提案 id 聚合全部相关档案) ----
  type Draft = {
    id: string;
    summary: string;
    kind: string;
    riskClass: string | null;
    layer: SurfaceLayer | null;
    edits: EditOp[];
    chain: TimelineStep[];
    measurement: ProposalMeasurement | null;
    backupRunId: string | null;
    lessonId: string | null;
    endedInReject: boolean;
    decided: "approved" | "rejected" | null;
    applied: boolean;
  };
  const drafts = new Map<string, Draft>();
  const ensureDraft = (id: string): Draft => {
    let draft = drafts.get(id);
    if (draft === undefined) {
      draft = {
        id,
        summary: id,
        kind: "",
        riskClass: null,
        layer: null,
        edits: [],
        chain: [],
        measurement: null,
        backupRunId: null,
        lessonId: null,
        endedInReject: false,
        decided: null,
        applied: false,
      };
      drafts.set(id, draft);
    }
    return draft;
  };

  // pending 存储给出提案正文(摘要/编辑/层);档案只追加,pending 是可变态。
  const pendingById = new Map<string, PendingRecord>();
  for (const record of pending) pendingById.set(record.id, record);

  for (const entry of entries) {
    const payload = payloadOf(entry);
    switch (entry.kind) {
      case PROPOSAL_ARCHIVE_KIND: {
        const id = String(payload.proposalId ?? "");
        if (id === "") break;
        const draft = ensureDraft(id);
        draft.riskClass = (payload.riskClass as string | undefined) ?? draft.riskClass;
        draft.chain.push({ stage: "proposed", at: isoTime(entry), note: "提案入队" });
        break;
      }
      case PROPOSAL_REJECT_ARCHIVE_KIND: {
        const id = String(payload.proposalId ?? "");
        if (id === "") break;
        const draft = ensureDraft(id);
        draft.endedInReject = true;
        draft.chain.push({
          stage: "discarded",
          at: isoTime(entry),
          note: `${String(payload.phase ?? "")} 丢弃:${String(payload.code ?? "")} — ${String(payload.reason ?? "")}`,
        });
        break;
      }
      case VERDICT_ARCHIVE_KIND: {
        const id = String(payload.proposalId ?? "");
        if (id === "") break;
        const draft = ensureDraft(id);
        draft.measurement = {
          decision: String(payload.decision ?? ""),
          reason: String(payload.reason ?? ""),
          targetIds: (payload.targetIds as string[] | undefined) ?? [],
          resolvedIds: (payload.resolvedIds as string[] | undefined) ?? [],
          introduced: (payload.introduced as string[] | undefined) ?? [],
        };
        draft.chain.push({
          stage: "verdict",
          at: isoTime(entry),
          note: `L1 ${draft.measurement.decision}:${draft.measurement.reason}`,
        });
        break;
      }
      case PROPOSAL_DECISION_ARCHIVE_KIND: {
        const id = String(payload.proposalId ?? "");
        if (id === "") break;
        const draft = ensureDraft(id);
        draft.decided = payload.decision === "rejected" ? "rejected" : "approved";
        draft.chain.push({
          stage: "decision",
          at: isoTime(entry),
          note: `管理面${draft.decided === "rejected" ? "拒绝" : "批准"}`,
        });
        break;
      }
      case "apply-run": {
        const runId = String(payload.runId ?? "");
        const failed = payload.failed === true;
        const ids = (payload.proposalIds as string[] | undefined) ?? [];
        for (const id of ids) {
          const draft = ensureDraft(id);
          if (failed) {
            draft.chain.push({ stage: "applied", at: isoTime(entry), note: `应用部分失败(run ${runId}):${String(payload.error ?? "")}` });
          } else {
            draft.applied = true;
            draft.backupRunId = runId;
            draft.chain.push({ stage: "applied", at: isoTime(entry), note: `应用完成(备份会话 ${runId},可回滚)` });
            // 生效时点回放(review-fixes ❌3):effects 随 apply-run 档案入档;
            // 旧档案无此字段如实跳过,不伪造。
            const effects = (payload.effects as { agent?: unknown; effect?: unknown }[] | undefined) ?? [];
            for (const effect of effects) {
              draft.chain.push({
                stage: "applied",
                at: isoTime(entry),
                note: `生效时点 ${String(effect.agent ?? "?")}:${String(effect.effect ?? "")}`,
              });
            }
          }
        }
        break;
      }
      case LESSON_ARCHIVE_KIND: {
        const lesson = entry.payload as unknown as Lesson;
        // lesson.id = `lesson-<safeProposalFileName>`:反查提案链。
        const stem = lesson.id.startsWith("lesson-") ? lesson.id.slice("lesson-".length) : lesson.id;
        for (const [id, draft] of drafts) {
          if (safeProposalFileName(id) === stem) {
            draft.lessonId = lesson.id;
            draft.chain.push({ stage: "lesson", at: isoTime(entry), note: `蒸馏 lesson: ${lesson.cue}` });
            break;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // pending 是提案正文源,且可能先于/独立于档案存在(如管理面直写):
  // 以 pending 记录同样播种追踪链,档案缺环如实空缺,不伪造补齐。
  for (const [id, record] of pendingById) {
    const draft = ensureDraft(id);
    if (draft.summary === id) draft.summary = record.proposal.summary;
    if (draft.kind === "") draft.kind = record.proposal.kind;
    if (draft.layer === null) draft.layer = record.proposal.layer;
    if (draft.edits.length === 0) draft.edits = [...record.proposal.edits];
    if (draft.riskClass === null) draft.riskClass = record.riskClass;
    if (draft.decided === null) draft.decided = record.status === "pending" ? null : record.status;
  }

  const timeline: ProposalTrace[] = [...drafts.values()]
    .map((draft): ProposalTrace => {
      const status: ProposalTrace["status"] = draft.applied
        ? "applied"
        : draft.endedInReject && draft.decided === null
          ? "discarded"
          : draft.decided === "rejected"
            ? "rejected"
            : draft.decided === "approved"
              ? "approved"
              : "pending";
      return {
        id: draft.id,
        summary: draft.summary,
        kind: draft.kind,
        riskClass: draft.riskClass,
        layer: draft.layer,
        status,
        chain: [...draft.chain].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
        measurement: draft.measurement,
        edits: draft.edits,
        backupRunId: draft.backupRunId,
        lessonId: draft.lessonId,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // ---- 趋势指标(可从档案重算;口径随数据导出) ----
  let resolvedTotal = 0;
  let decidedCount = 0;
  let approvedCount = 0;
  for (const entry of entries) {
    if (entry.kind === VERDICT_ARCHIVE_KIND) {
      resolvedTotal += (payloadOf(entry).resolvedIds as string[] | undefined)?.length ?? 0;
    }
    if (entry.kind === PROPOSAL_DECISION_ARCHIVE_KIND) {
      decidedCount += 1;
      if (payloadOf(entry).decision === "approved") approvedCount += 1;
    }
  }
  const jobEntries = entries.filter((entry) => entry.kind === JOB_RUN_KIND);
  const jobFailures = jobEntries.filter((entry) => typeof payloadOf(entry).error === "string");
  const everMeasured = entries.some((entry) => entry.kind === VERDICT_ARCHIVE_KIND);
  const everDecided = decidedCount > 0;
  const trends: TrendMetric[] = [
    {
      id: "findings-resolved",
      label: "累计发现解决数",
      value: everMeasured ? resolvedTotal : null,
      source: "verdict 档案 resolvedIds 累计",
    },
    {
      id: "adoption-rate",
      label: "提案采纳率",
      value: everDecided ? approvedCount / decidedCount : null,
      source: "proposal-decision 档案 approved / 全部决策",
    },
    {
      id: "rejection-rate",
      label: "提案拒绝率",
      value: everDecided ? (decidedCount - approvedCount) / decidedCount : null,
      source: "proposal-decision 档案 rejected / 全部决策",
    },
    {
      id: "job-runs",
      label: "作业运行次数",
      value: jobEntries.length > 0 ? jobEntries.length : null,
      source: "job-run 档案条数",
    },
    {
      id: "job-failures",
      label: "作业失败次数",
      value: jobEntries.length > 0 ? jobFailures.length : null,
      source: "job-run 档案含 error 字段的条数",
    },
  ];

  // ---- 作业运行与通知 ----
  const jobRuns: JobRunEntry[] = jobEntries.map((entry) => {
    const payload = payloadOf(entry);
    const summary = (payload.summary ?? {}) as Record<string, unknown>;
    return {
      startedAt: new Date(Number(payload.startedAtMs ?? 0)).toISOString(),
      endedAt:
        typeof payload.endedAtMs === "number" ? new Date(payload.endedAtMs).toISOString() : null,
      ok: typeof payload.error !== "string",
      error: typeof payload.error === "string" ? payload.error : null,
      trigger: payload.trigger === "manual" || payload.trigger === "chain" ? payload.trigger : "event",
      summary: {
        signalsConsidered: typeof summary.signalsConsidered === "number" ? summary.signalsConsidered : null,
        enqueued: Array.isArray(summary.enqueuedIds) ? summary.enqueuedIds.length : null,
        autoAdopted: Array.isArray(summary.autoAdoptedIds) ? summary.autoAdoptedIds.length : null,
      },
    };
  });
  const notices: string[] = [];
  for (const entry of jobEntries) {
    const summary = (payloadOf(entry).summary ?? {}) as { notices?: unknown };
    if (Array.isArray(summary.notices)) {
      for (const notice of summary.notices) if (typeof notice === "string") notices.push(notice);
    }
  }

  // ---- 状态与计数 ----
  const counts = {
    pending: pending.filter((record) => record.status === "pending").length,
    approved: pending.filter((record) => record.status === "approved").length,
    rejected: pending.filter((record) => record.status === "rejected").length,
    approvedUnapplied: timeline.filter((trace) => trace.status === "approved").length,
  };
  const hasPolicy = policy.defaultLevel !== undefined ||
    Object.keys(policy.agents).length > 0 ||
    Object.keys(policy.workspaces).length > 0;
  const hasActivity = entries.length > 0 || pending.length > 0;
  const state: EvolveViewState = !hasActivity && !hasPolicy ? "not-enabled" : hasActivity ? "active" : "enabled-idle";

  return {
    state,
    levels: levelMap(policy),
    counts,
    timeline,
    trends,
    jobRuns,
    notices,
  };
}
