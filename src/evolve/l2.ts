/**
 * L2 匿名前后对比记录协议(trellis-evolve 任务 13.1)。
 *
 * spec"匿名前后对比记录协议(L2)":内容类对比的比较记录以类型化档案
 * 格式持久化——baseline 与候选各自的运行标识、冻结的交付物引用、按
 * 任务设种子的匿名标识映射、选择器结果与失败收口的 verdict;base 保留在
 * 比较中;记录格式表达两种收口:选中 baseline ⟹ 不采纳,选择器失败 ⟹
 * invalid。本模块只定义记录格式与边界;选择器执行(运行比较与裁决)不
 * 在本期范围。
 *
 * 匿名性:呈现给选择器的匿名标识(anonId)由任务种子 + 运行标识派生,
 * 本身不含角色词;选择器视图(`presentL2Arms`)只给 anonId 与冻结交付
 * 物引用,不带 role/runId。角色映射只存在于档案(审计用)。
 */

import { createHash } from "node:crypto";
import type { ArchiveEntry } from "./archive.js";
import { appendArchiveRecord, readArchiveRecords } from "./archive.js";

/** 运行档案 kind:一条 L2 比较记录。 */
export const L2_COMPARISON_ARCHIVE_KIND = "l2-comparison";

export type L2ArmRole = "baseline" | "candidate";

/** 冻结的交付物引用:标签 + 内容摘要键(切片任何变化即键变)。 */
export interface L2FrozenArtifact {
  readonly label: string;
  readonly digest: string;
}

export interface L2Arm {
  /** 种子派生的匿名标识(呈现面);不含角色词。 */
  readonly anonId: string;
  /** 该臂自己的运行标识。 */
  readonly runId: string;
  readonly role: L2ArmRole;
  readonly artifacts: readonly L2FrozenArtifact[];
}

/** 按任务设种子:每条探针任务一个种子,匿名标识由此派生。 */
export interface L2TaskSeed {
  readonly task: string;
  readonly seed: string;
}

export type L2SelectorResult =
  | { readonly status: "selected"; readonly anonId: string }
  | { readonly status: "failed"; readonly reason: string };

/** 失败收口的 verdict:
 *   - selected baseline → not-adopted(不采纳);
 *   - 选择器失败 / 任一臂未交付 → invalid(同样不采纳,收口形态不同)。 */
export type L2Verdict =
  | { readonly kind: "adopt-candidate"; readonly anonId: string }
  | { readonly kind: "not-adopted-baseline"; readonly anonId: string }
  | { readonly kind: "invalid"; readonly reason: string };

export interface L2ComparisonRecord {
  readonly comparisonId: string;
  readonly createdAt: number;
  readonly taskSeeds: readonly L2TaskSeed[];
  /** baseline 与候选全在(base 留池,13.2 的偏差在引擎侧,记录层照存)。 */
  readonly arms: readonly L2Arm[];
  readonly selector: L2SelectorResult;
  readonly verdict: L2Verdict;
}

/**
 * 匿名标识:按任务种子 + 运行标识派生的稳定短哈希。构造上不可能
 * 含角色词——呈现面与档案里的值同源,泄露面为零。
 */
export function anonArmId(taskSeeds: readonly L2TaskSeed[], runId: string): string {
  const seedKey = taskSeeds
    .map((entry) => `${entry.task}=${entry.seed}`)
    .join("&");
  const digest = createHash("sha256").update(`${seedKey}#${runId}`).digest("hex");
  return `arm-${digest.slice(0, 16)}`;
}

export interface BuildL2ComparisonInput {
  readonly comparisonId: string;
  readonly createdAt: number;
  readonly taskSeeds: readonly L2TaskSeed[];
  /** 每臂运行标识 + 角色 + 冻结交付物;anonId 由本函数派生。 */
  readonly arms: readonly { readonly runId: string; readonly role: L2ArmRole; readonly artifacts: readonly L2FrozenArtifact[] }[];
  readonly selector: L2SelectorResult;
}

function verdictFor(arms: readonly L2Arm[], selector: L2SelectorResult): L2Verdict {
  if (selector.status === "failed") {
    return { kind: "invalid", reason: selector.reason };
  }
  const picked = arms.find((arm) => arm.anonId === selector.anonId);
  if (picked === undefined) {
    return { kind: "invalid", reason: `selector picked unknown arm ${selector.anonId}` };
  }
  // 任一臂未交付:无 artifacts 的臂视为未交付(design:不采纳收口)。
  if (arms.some((arm) => arm.artifacts.length === 0)) {
    return { kind: "invalid", reason: "arm-undelivered" };
  }
  if (picked.role === "baseline") {
    return { kind: "not-adopted-baseline", anonId: picked.anonId };
  }
  return { kind: "adopt-candidate", anonId: picked.anonId };
}

/** 由臂与选择器结果构建完整记录(派生匿名映射 + 失败收口 verdict)。 */
export function buildL2Comparison(input: BuildL2ComparisonInput): L2ComparisonRecord {
  const arms: L2Arm[] = input.arms.map((arm) => ({
    anonId: anonArmId(input.taskSeeds, arm.runId),
    runId: arm.runId,
    role: arm.role,
    artifacts: arm.artifacts,
  }));
  return {
    comparisonId: input.comparisonId,
    createdAt: input.createdAt,
    taskSeeds: input.taskSeeds,
    arms,
    selector: input.selector,
    verdict: verdictFor(arms, input.selector),
  };
}

/** 追加一条比较记录到运行档案。 */
export function appendL2Comparison(
  homeDir: string,
  record: L2ComparisonRecord,
  now: () => Date = () => new Date(),
): ArchiveEntry {
  return appendArchiveRecord(homeDir, { kind: L2_COMPARISON_ARCHIVE_KIND, payload: record }, now);
}

/** 读回全部比较记录(档案读取,零副作用)。 */
export function readL2Comparisons(homeDir: string): L2ComparisonRecord[] {
  const records: L2ComparisonRecord[] = [];
  for (const entry of readArchiveRecords(homeDir)) {
    if (entry.kind !== L2_COMPARISON_ARCHIVE_KIND) continue;
    records.push(entry.payload as L2ComparisonRecord);
  }
  return records;
}

/** 选择器视图:只给匿名标识与冻结交付物引用——不带 role/runId。 */
export function presentL2Arms(record: L2ComparisonRecord): { readonly anonId: string; readonly artifacts: readonly L2FrozenArtifact[] }[] {
  return record.arms.map((arm) => ({ anonId: arm.anonId, artifacts: arm.artifacts }));
}
