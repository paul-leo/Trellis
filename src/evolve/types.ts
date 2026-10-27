/**
 * 进化核心类型(trellis-evolve 任务 10.1)。
 *
 * Signal、Proposal、Verdict、Lesson、RiskClass、Level。`layer` 字段贯穿
 * 所有落盘类型(Signal 信封、Proposal、Verdict、Lesson);workspaceRoot 不
 * 入库 —— 层归属在采集端从会话观察派生,随每条记录完整序列化往返。
 *
 * 事件字段白名单与 `src/host/hostEvents.ts` 同源:结果类别从那里
 * re-export(10.3 的边界允许 `@trellis/evolve-engine` 与 `src/host/*`)。
 */

import type { CheckEntry, EditOp, SurfaceLayer } from "../host/index.js";
import type { ToolResultCategory } from "../host/hostEvents.js";

// Level/LEVELS 的单一事实源在 `src/host/levels.ts`(10.2 的分级开启:
// 级别策略是 canonical 配置,格式与解析归 host,doctor 与本消费者同源);
// 这里 re-export 保持核心类型面完整。直接取 `../host/levels.js` 而非
// 整个门面,避免类型模块拖入 checks/edits 的运行时链。
export { LEVELS } from "../host/levels.js";
export type { Level } from "../host/levels.js";

/**
 * 风险分类:A 仅在 `auto-A` 且通过校验时自动采纳;B 永远需人工批准;
 * C 在校验阶段硬排除。无法分类按 B;仅单 workspace 证据支撑的全局升格
 * 一律 B(12.3 的分类器与采纳门)。
 */
export type RiskClass = "A" | "B" | "C";

/** 结果类别白名单的单一事实源在 `src/host/hostEvents.ts`。 */
export type { ToolResultCategory } from "../host/hostEvents.js";

/** 信号来源:网关事件、agent 显式上报、agent-bridge 委托记录、历史导入
 * (run-backfill:用户显式选定的 session 数据回填,stableId `import:*`)。 */
export type SignalSource = "gateway-event" | "agent-report" | "agent-bridge" | "history-import";

export type SignalKind = "tool-call" | "session-start" | "session-end" | "user-correction";

/**
 * 信号信封:来源种类、来源提供的稳定标识(来源没有则 null)、采集时间、
 * 层归属。事件负载只保留字段白名单 —— ts / agent / session / provider /
 * tool / durationMs / result;入参与结果内容一律不入库(11.1 的 recorder
 * 负责擦除)。
 */
interface SignalEnvelope {
  readonly kind: SignalKind;
  readonly source: SignalSource;
  readonly stableId: string | null;
  readonly collectedAt: number;
  readonly layer: SurfaceLayer;
}

export interface ToolCallSignal extends SignalEnvelope {
  readonly kind: "tool-call";
  readonly ts: number;
  readonly agent: string;
  readonly session: string;
  readonly provider: string;
  readonly tool: string;
  readonly durationMs: number;
  readonly result: ToolResultCategory;
}

export interface SessionStartSignal extends SignalEnvelope {
  readonly kind: "session-start";
  readonly ts: number;
  readonly agent: string;
  readonly session: string;
}

export interface SessionEndSignal extends SignalEnvelope {
  readonly kind: "session-end";
  readonly ts: number;
  readonly agent: string;
  readonly session: string;
}

/** 用户纠正(text 已过 secrets 擦除;原始文本与 workspaceRoot 均不入库)。 */
export interface UserCorrectionSignal extends SignalEnvelope {
  readonly kind: "user-correction";
  readonly ts: number;
  readonly agent: string;
  readonly session: string;
  readonly text: string;
}

export type Signal = ToolCallSignal | SessionStartSignal | SessionEndSignal | UserCorrectionSignal;

/**
 * 证据链接三形态:引擎运行、doctor 发现、用户纠正信号。`layer` 可选 ——
 * 证据的采集层归属(12.2 的"不自动升格"判定据此识别单 workspace 证据);
 * 缺省视为层未知,不计入"另一上下文"的佐证。
 */
export type EvidenceLink =
  | { readonly kind: "run"; readonly runId: string; readonly layer?: SurfaceLayer }
  | { readonly kind: "doctor-finding"; readonly findingId: string; readonly layer?: SurfaceLayer }
  | { readonly kind: "user-correction"; readonly signalId: string; readonly layer?: SurfaceLayer };

/**
 * 提案:`kind` / `target` 的准入白名单与机械校验在 12.2(配置类 kind 才
 * 进入提案通道);风险分类与采纳门在 12.3。
 */
export interface Proposal {
  readonly id: string;
  readonly createdAt: number;
  readonly kind: string;
  readonly target: string;
  readonly layer: SurfaceLayer;
  readonly evidence: readonly EvidenceLink[];
  readonly riskClass: RiskClass;
  readonly summary: string;
  readonly edits: readonly EditOp[];
}

/** Verdict 条目与 host 检查条目同形:稳定 id 参与比较,layer 随行。 */
export type VerdictEntry = CheckEntry;

/**
 * L1 差集的测量结果:baseline 与 candidate 各一份完整条目集;可采纳
 * 判定留给 12.1(无新条目 ∧ 目标条目被消除 ∧ 其余不变)。测量失败记
 * `unknown`,不得表示为零分或通过;意外错误按"不采纳"收口在采纳侧。
 */
export interface Verdict {
  readonly status: "ok" | "unknown";
  readonly layer: SurfaceLayer;
  readonly baseline: readonly VerdictEntry[];
  readonly candidate: readonly VerdictEntry[];
}

/** Lesson:cue / 正文 / 证据链接 / 可选 confidence / 层作用域。 */
export interface Lesson {
  readonly id: string;
  readonly createdAt: number;
  readonly cue: string;
  readonly body: string;
  readonly evidence: readonly EvidenceLink[];
  readonly confidence?: number;
  readonly layer: SurfaceLayer;
}
