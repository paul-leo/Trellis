/**
 * agent 只读接口(trellis-evolve 任务 12.4,spec"pending 提案对 agent
 * 可见")。
 *
 * 暴露给被进化 agent 的进化接口只有两类:读 pending 摘要(本模块)与
 * 上报用户纠正(`report.ts`)。本模块**没有任何**批准、拒绝、应用或写
 * 入操作,也不 re-export 它们 —— 批准只走管理面命令的交互式终端
 * (spec"批准只走带外通道")。返回内容:摘要、证据与风险级别;文本经
 * secrets 擦除(纵深,存储层已拒凭据形态内容),不含凭据材料、不含
 * 编辑正文。
 */

import { eraseSecrets } from "./erase.js";
import { readProposalsByStatus } from "./pending.js";
import type { ProposalStatus } from "./pending.js";
import type { EvidenceLink, RiskClass } from "./types.js";

/** 证据的 agent 可见描述(只读;ref 为稳定标识,已擦除)。 */
export interface AgentEvidenceView {
  readonly kind: string;
  readonly ref: string;
}

/** 一条 pending 提案的 agent 可见摘要。 */
export interface AgentPendingSummary {
  readonly id: string;
  readonly summary: string;
  readonly riskClass: RiskClass;
  readonly status: ProposalStatus;
  readonly evidence: readonly AgentEvidenceView[];
  readonly createdAt: number;
}

function evidenceRef(link: EvidenceLink): string {
  const raw = link.kind === "run" ? link.runId : link.kind === "doctor-finding" ? link.findingId : link.signalId;
  return eraseSecrets(raw);
}

/**
 * 列出全部 pending 提案的只读摘要。存在几条返回几条(spec 场景:两条
 * pending → 两条摘要、证据与风险级别)。只读:不建目录、不写档案。
 */
export function listPendingSummaries(homeDir: string): AgentPendingSummary[] {
  return readProposalsByStatus(homeDir, "pending").map((record) => ({
    id: record.id,
    summary: eraseSecrets(record.proposal.summary),
    riskClass: record.riskClass,
    status: record.status,
    evidence: record.proposal.evidence.map((link) => ({
      kind: link.kind,
      ref: evidenceRef(link),
    })),
    createdAt: record.createdAt,
  }));
}
