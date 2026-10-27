/**
 * 风险分类器与采纳门(trellis-evolve 任务 12.3)。
 *
 * 分级由代码按 **kind + target 形态** 数据驱动计算,不采信 editor 自报的
 * `riskClass`(design D9):
 *
 *   - Class A(可逆、零爆炸半径、证据确凿的机器本地单文件修复)—— 仅
 *     级别 `auto-A` 且 probe 通过时自动采纳,采纳后通知(指明编辑、证据
 *     与回滚路径);
 *   - Class B(内容/路由/对外副作用非零)—— 永远需要人对 diff 与证据的
 *     显式批准,不受级别影响;
 *   - Class C(受保护目标)—— 已在 12.2 机械校验阶段拒绝,分类器只为
 *     完备性映射,不可达;
 *   - 无法分类(未知 kind / target 形态不匹配)→ 一律按 B;
 *   - 以全局层为目标、仅由单 workspace 证据(或证据层未知)支撑的升格
 *     编辑 → 一律 B(消费 12.2 的 `needsExplicitApproval` 标记)。
 *
 * 分类表的 A 例取自 `docs/self-evolution.md` 的既定设计:"补一个
 * `${VAR}` 名"(secrets-policy-fix → secrets.policy.yaml)与"修复 doctor
 * 已报告的 drift"(sync-config-fix → agent 原生 home 配置面);workspace
 * 配置文件常被 git 跟踪、团队可见,对外副作用非零 → B(与 tasks 14.1
 * E2E 的"Class B 呈现、带外批准"一致);MCP 路由变更 → B("内容或路由
 * 编辑")。
 */

import { basename, join, relative, resolve, sep } from "node:path";
import type { Level } from "../host/index.js";
import { NATIVE_CHECK_SURFACE } from "../host/index.js";
import type { EvidenceLink, Proposal, RiskClass } from "./types.js";
import { evaluatePromotion, protectedPathReason } from "./validate.js";

/** target 形态:规则表的第二维。 */
export type TargetShape = "any" | "agent-native" | "secrets-policy";

export interface RiskRule {
  readonly id: string;
  /** C 类不进规则表(前置硬排除),表内只有 A/B。 */
  readonly riskClass: "A" | "B";
  readonly kind: string;
  readonly targetShape: TargetShape;
  readonly note: string;
}

/**
 * 分类表(按序首条命中即用;未命中走兜底 B)。数据驱动:新增形态加行,
 * 不写分支特例。
 */
export const RISK_RULES: readonly RiskRule[] = [
  // A:可逆、零爆炸半径 —— 机器本地单文件,备份会话内逐字节可回滚。
  {
    id: "sync-config-fix/agent-native",
    riskClass: "A",
    kind: "sync-config-fix",
    targetShape: "agent-native",
    note: "修复 doctor 已报告的投递面 drift:agent 原生 home 配置单文件,零对外半径",
  },
  {
    id: "secrets-policy-fix/secrets-policy",
    riskClass: "A",
    kind: "secrets-policy-fix",
    targetShape: "secrets-policy",
    note: "策略文件只含变量名/拒绝模式(补 `${VAR}` 名形态),机器本地可回滚",
  },
  // B:内容/路由/对外副作用非零。
  {
    id: "workspace-config-fix/any",
    riskClass: "B",
    kind: "workspace-config-fix",
    targetShape: "any",
    note: "workspace 配置常被 git 跟踪(团队可见),对外副作用非零",
  },
  {
    id: "mcp-config-fix/any",
    riskClass: "B",
    kind: "mcp-config-fix",
    targetShape: "any",
    note: "MCP 路由变更,永远人批",
  },
  {
    id: "oauth-config-fix/any",
    riskClass: "B",
    kind: "oauth-config-fix",
    targetShape: "any",
    note: "auth 相邻配置,不自动",
  },
];

export interface RiskClassification {
  readonly riskClass: RiskClass;
  /** 命中的规则 id,或前置/兜底标识。 */
  readonly ruleId: string;
  readonly reason: string;
  /** 升格降级是否发生(12.2 `needsExplicitApproval` 的消费痕迹)。 */
  readonly demotedByPromotion: boolean;
}

export interface ClassifyOptions {
  readonly homeDir: string;
  /**
   * 12.2 的不自动升格标记;缺省按 `evaluatePromotion` 从提案自身证据层
   * 重算(同源判定)。
   */
  readonly needsExplicitApproval?: boolean;
}

/** 提案涉及的全部路径(target 描述 + 各编辑路径)。 */
function pathsOf(proposal: Proposal): readonly string[] {
  return [proposal.target, ...proposal.edits.map((edit) => edit.path)];
}

/** homeDir 相对路径形态;home 外或非绝对形态返回原始串(走尾缀匹配)。 */
function relOfHome(path: string, homeDir: string): string {
  const abs = resolve(path);
  const rel = relative(resolve(homeDir), abs);
  return rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`)) ? path : rel;
}

function matchesShape(shape: TargetShape, proposal: Proposal, homeDir: string): boolean {
  if (shape === "any") return true;
  const rels = pathsOf(proposal).map((path) => relOfHome(path, homeDir));
  if (shape === "secrets-policy") {
    const policy = join(".trellis", "secrets.policy.yaml");
    return rels.some((rel) => rel === policy || basename(rel) === "secrets.policy.yaml");
  }
  // agent-native:NATIVE_CHECK_SURFACE 条目(或其内)。
  return rels.some((rel) =>
    NATIVE_CHECK_SURFACE.some((entry) => rel === entry || rel.startsWith(entry + sep)),
  );
}

/**
 * 风险分类(kind + target 形态 → A/B/C)。不采信 `proposal.riskClass`
 * 自报值;C 类目标在 12.2 校验阶段已拒,此处只为完备性映射。
 */
export function classifyProposalRisk(proposal: Proposal, options: ClassifyOptions): RiskClassification {
  // C 前置:target 描述符的 auth 形态 + 受保护路径(与 12.2 同源)。
  if (/\bauth\b/i.test(proposal.target)) {
    return {
      riskClass: "C",
      ruleId: "protected/auth-descriptor",
      reason: `提案目标 "${proposal.target}" 为 MCP auth 配置形态(校验阶段已拒)`,
      demotedByPromotion: false,
    };
  }
  for (const path of pathsOf(proposal)) {
    const reason = protectedPathReason(path, options.homeDir);
    if (reason !== null) {
      return {
        riskClass: "C",
        ruleId: "protected/path",
        reason: `${path}:${reason}(校验阶段已拒)`,
        demotedByPromotion: false,
      };
    }
  }

  // 升格降级:全局层目标 + 仅单 workspace 证据(或层未知)→ 一律 B。
  const needsExplicitApproval =
    options.needsExplicitApproval ?? evaluatePromotion(proposal).needsExplicitApproval;
  const demotedByPromotion = needsExplicitApproval && proposal.layer.kind === "global";
  if (demotedByPromotion) {
    return {
      riskClass: "B",
      ruleId: "promotion-demotion",
      reason: "全局层升格编辑仅由单 workspace 证据(或证据层未知)支撑,一律按 B 处理",
      demotedByPromotion: true,
    };
  }

  // 规则表:按序首条命中。
  for (const rule of RISK_RULES) {
    if (rule.kind !== proposal.kind) continue;
    if (!matchesShape(rule.targetShape, proposal, options.homeDir)) continue;
    return {
      riskClass: rule.riskClass,
      ruleId: rule.id,
      reason: rule.note,
      demotedByPromotion: false,
    };
  }

  // 兜底:未知 kind / 形态不匹配 → 无法分类按 B。
  return {
    riskClass: "B",
    ruleId: "fallback-unclassified",
    reason: `kind "${proposal.kind}" / target "${proposal.target}" 不匹配任何已知分类规则,无法分类按 B 处理`,
    demotedByPromotion: false,
  };
}

/** 自动采纳的通知负载:指明编辑、证据与回滚路径(spec 场景 1)。 */
export interface AdoptionNotification {
  readonly message: string;
  readonly proposalId: string;
  readonly editPaths: readonly string[];
  readonly evidence: readonly EvidenceLink[];
  readonly rollbackPath: string;
}

export type AdoptionDecision =
  | {
      readonly action: "auto-adopt";
      readonly riskClass: "A";
      readonly reason: string;
      readonly notification: AdoptionNotification;
    }
  | {
      readonly action: "await-approval";
      readonly riskClass: RiskClass;
      readonly reason: string;
    };

export interface AdoptionGateInput {
  readonly level: Level;
  readonly classification: RiskClassification;
  /** L1 前闸 verdict 差集可采纳(true = probe 通过)。 */
  readonly probePassed: boolean;
  readonly proposal: Proposal;
  /**
   * 回滚路径指引;缺省指向标准备份会话语义(12.5 应用时会写入真实会话
   * 标识,由调用方替换为具体指引)。
   */
  readonly rollbackHint?: string;
}

export const DEFAULT_ROLLBACK_HINT = "trellis rollback --list(标准备份会话内逐字节还原)";

function describeEvidence(link: EvidenceLink): string {
  const id = link.kind === "run" ? link.runId : link.kind === "doctor-finding" ? link.findingId : link.signalId;
  return `${link.kind}:${id}`;
}

function buildNotification(input: AdoptionGateInput, reason: string): AdoptionNotification {
  const { proposal, classification } = input;
  const rollbackPath = input.rollbackHint ?? DEFAULT_ROLLBACK_HINT;
  const editPaths = proposal.edits.map((edit) => edit.path);
  const message = [
    `自动采纳 Class A 提案 ${proposal.id}(${classification.ruleId}):${reason}`,
    `编辑:${editPaths.join(", ")}`,
    `证据:${proposal.evidence.map(describeEvidence).join("; ")}`,
    `回滚:${rollbackPath}`,
  ].join("\n");
  return { message, proposalId: proposal.id, editPaths, evidence: proposal.evidence, rollbackPath };
}

/**
 * 应用后用真实备份会话标识重写通知的回滚行(review-fixes ❌5)。决策时
 * 备份会话尚不存在,回滚行只能是泛化占位;应用拿到真实 runId 后由调用
 * 方经本函数回填。只重写 `回滚:` 行,其余行不动;格式由 buildNotification
 * 单点控制。
 */
export function retargetNotificationRollback(
  notification: AdoptionNotification,
  rollbackPath: string,
): AdoptionNotification {
  const message = notification.message
    .split("\n")
    .map((line) => (line.startsWith("回滚:") ? `回滚:${rollbackPath}` : line))
    .join("\n");
  return { ...notification, message, rollbackPath };
}

/**
 * 采纳门:A 仅在级别 `auto-A` 且 probe 通过时自动采纳(并产出通知);
 * B 永远需要显式批准,不受级别影响;C 不可达(校验阶段已拒)防御性按
 * 待批准收口。probe 未通过或级别低于 `auto-A` 时 Class A 也不自动采纳。
 */
export function evaluateAdoptionGate(input: AdoptionGateInput): AdoptionDecision {
  const { classification, level, probePassed } = input;

  if (classification.riskClass === "C") {
    return {
      action: "await-approval",
      riskClass: "C",
      reason: "C 类受保护目标在校验阶段已拒绝,不进入自动采纳",
    };
  }
  if (classification.riskClass === "B") {
    return {
      action: "await-approval",
      riskClass: "B",
      reason: classification.demotedByPromotion
        ? `${classification.reason}(不自动采纳,呈现等待显式批准)`
        : "B 类编辑永远需要人对 diff 与证据的显式批准,不受级别影响",
    };
  }
  // Class A。
  if (level !== "auto-A") {
    return {
      action: "await-approval",
      riskClass: "A",
      reason: `级别 "${level}" 低于 auto-A,Class A 也不自动采纳(呈现等待批准)`,
    };
  }
  if (!probePassed) {
    return {
      action: "await-approval",
      riskClass: "A",
      reason: "probe 未通过(L1 前闸不可采纳),不自动采纳",
    };
  }
  const reason = "级别 auto-A、Class A 且 probe 通过";
  return {
    action: "auto-adopt",
    riskClass: "A",
    reason,
    notification: buildNotification(input, reason),
  };
}
