/**
 * pending 提案存储与状态机(trellis-evolve 任务 12.4)。
 *
 * 存储在状态目录 `~/.trellis/evolve/pending/`(10.4 的规划子目录):
 * 一提案一 JSON 文件,状态 `pending → approved | rejected` 只经管理面
 * 命令变更(批准仅限交互式终端,见 `src/commands/evolve.ts`)。agent
 * 侧的只读视图在 `agentView.ts` —— 暴露面物理分离,批准/应用能力不在
 * agent 可达模块里(spec"批准只走带外通道")。
 *
 * 决策写运行档案(`proposal-decision`),与提案/verdict 同一条只追加
 * 审计链;存储文件本身是可变状态(提案状态迁移),不是档案。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendArchiveRecord } from "./archive.js";
import { evolveStateDir } from "./stateDir.js";
import type { Proposal, RiskClass } from "./types.js";

/**
 * 原子写 pending 记录(tmp + rename,新建 0600):pending 是可变磁盘
 * 状态,半写的 JSON 会让 `readPendingRecords` 整体抛错(status/pending/
 * 作业全受影响)。本目录只依赖 host 门面与 node 内置(边界 10.3),
 * 助手就地实现,不引 src/lib。
 */
function writeRecordAtomic(path: string, record: PendingRecord): void {
  const temporary = join(dirname(path), `.atomic-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(temporary, JSON.stringify(record, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  renameSync(temporary, path);
}

/** 提案状态:待批 → 已批准(待应用)/ 已拒绝。 */
export type ProposalStatus = "pending" | "approved" | "rejected";

/** 档案 kind:管理面批准/拒绝决策。 */
export const PROPOSAL_DECISION_ARCHIVE_KIND = "proposal-decision";

/** pending 存储中的一条提案记录(提案 + 分类结果 + 状态)。 */
export interface PendingRecord {
  readonly id: string;
  readonly status: ProposalStatus;
  readonly riskClass: RiskClass;
  /** 12.3 分类器命中的规则 id(审计用;不采信 proposal 自报)。 */
  readonly riskRuleId: string;
  readonly proposal: Proposal;
  readonly createdAt: number;
  /** 决策时间(毫秒);未决策为 null。 */
  readonly decidedAt: number | null;
}

/** pending 存储目录(只在状态目录下落盘)。 */
export function pendingRecordsDir(homeDir: string): string {
  return join(evolveStateDir(homeDir), "pending");
}

/** 提案 id → 文件名(路径安全字符;保留可读前缀)。 */
export function safeProposalFileName(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe === "" || safe === "." || safe === ".." ? "proposal" : safe;
}

function pendingFilePath(homeDir: string, id: string): string {
  return join(pendingRecordsDir(homeDir), `${safeProposalFileName(id)}.json`);
}

function readRecordFile(path: string): PendingRecord {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as PendingRecord;
  if (typeof parsed.id !== "string" || typeof parsed.status !== "string") {
    throw new Error(`pending: ${path} 形态不符(缺 id/status)`);
  }
  return parsed;
}

/**
 * 入队一条提案(状态 pending)。分类结果由调用方经 12.3 分类器算出后
 * 传入 —— 存储层不重算,只留审计痕迹。
 */
export function enqueueProposal(options: {
  readonly homeDir: string;
  readonly proposal: Proposal;
  readonly riskClass: RiskClass;
  readonly riskRuleId: string;
  readonly now?: () => number;
}): PendingRecord {
  const now = (options.now ?? Date.now)();
  const record: PendingRecord = {
    id: options.proposal.id,
    status: "pending",
    riskClass: options.riskClass,
    riskRuleId: options.riskRuleId,
    proposal: options.proposal,
    createdAt: now,
    decidedAt: null,
  };
  mkdirSync(pendingRecordsDir(options.homeDir), { recursive: true, mode: 0o700 });
  writeRecordAtomic(pendingFilePath(options.homeDir, record.id), record);
  return record;
}

/** 读回全部提案记录(按 id 排序;目录不存在返回 [],读取零副作用)。 */
export function readPendingRecords(homeDir: string): PendingRecord[] {
  const dir = pendingRecordsDir(homeDir);
  if (!existsSync(dir)) return [];
  const records: PendingRecord[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    records.push(readRecordFile(join(dir, name)));
  }
  return records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 按状态过滤。 */
export function readProposalsByStatus(homeDir: string, status: ProposalStatus): PendingRecord[] {
  return readPendingRecords(homeDir).filter((record) => record.status === status);
}

/** 单条读取;不存在返回 null。 */
export function readPendingRecord(homeDir: string, id: string): PendingRecord | null {
  const path = pendingFilePath(homeDir, id);
  if (!existsSync(path)) return null;
  return readRecordFile(path);
}

export type ProposalDecision = "approved" | "rejected";

export type DecideProposalResult =
  | { readonly ok: true; readonly record: PendingRecord }
  | { readonly ok: false; readonly error: "not-found" | "already-decided" };

/**
 * 管理面决策(仅 `src/commands/evolve.ts` 的交互式批准路径调用;agent
 * 可达面没有本函数)。写状态迁移 + 档案 `proposal-decision`;重复决策
 * 拒绝(状态机单向)。
 */
export function decideProposal(options: {
  readonly homeDir: string;
  readonly id: string;
  readonly decision: ProposalDecision;
  readonly now?: () => number;
}): DecideProposalResult {
  const existing = readPendingRecord(options.homeDir, options.id);
  if (existing === null) return { ok: false, error: "not-found" };
  if (existing.status !== "pending") return { ok: false, error: "already-decided" };

  const now = (options.now ?? Date.now)();
  const record: PendingRecord = { ...existing, status: options.decision, decidedAt: now };
  writeRecordAtomic(pendingFilePath(options.homeDir, record.id), record);
  appendArchiveRecord(
    options.homeDir,
    {
      kind: PROPOSAL_DECISION_ARCHIVE_KIND,
      payload: {
        proposalId: record.id,
        decision: options.decision,
        riskClass: record.riskClass,
        riskRuleId: record.riskRuleId,
      },
    },
    () => new Date(now),
  );
  return { ok: true, record };
}
