/**
 * 提案通道选择与 rule-based fallback(trellis-evolve 任务 12.2)。
 *
 * 正常通道是 editor(agent-bridge `runDelegatedCall` 委派或 spawn 本机
 * CLI);委派/spawn 双不可用时,doctor finding 形态的信号走 rule-based
 * 提案 —— 对有显而易见机械修复的 finding kind 直接构造提案,不调模型。
 * 本期唯一定义的机械修复:`workspace-toml-invalid` 把解析失败行注释掉
 * (TOML 有注释语法且 doctor 消息带行号;JSON 无注释语法、无行号的
 * 情形返回 null,不硬造)。
 *
 * rule-based 产出的提案是草稿:仍要过 12.2 机械校验与 12.1 的 L1 前闸,
 * 是否真的修好由 verdict 差集说话,不在这里担保。`riskClass` 只是占位
 * ("B"),12.3 按 kind+target 重算,不采信自报。
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { CheckEntry, SurfaceLayer } from "../host/index.js";
import type { EvidenceLink, Proposal, Signal } from "./types.js";

/** 提案通道可用性:委派(agent-bridge)与 spawn(本机 CLI)各一票。 */
export interface ProposalChannelAvailability {
  readonly delegate: boolean;
  readonly spawn: boolean;
}

/**
 * 通道选择:任一通道可用走 editor;双不可用才降级 rule-based。
 * rule-based 不是"更好的编辑",是无模型可用时对机械可修 finding 的兜底。
 */
export function selectProposalChannel(
  availability: ProposalChannelAvailability,
): "editor" | "rule-based" {
  return availability.delegate || availability.spawn ? "editor" : "rule-based";
}

/** doctor finding 形态信号:stableId 以 `doctor:` 开头(= CheckEntry.id)。 */
export function isDoctorFindingSignal(signal: Pick<Signal, "stableId">): boolean {
  return signal.stableId !== null && signal.stableId.startsWith("doctor:");
}

/** doctor 的 workspace-toml 消息分隔符(U+2014 EM DASH),与
 * `src/commands/doctor.ts` 的拼装逐字对齐。 */
const MESSAGE_SEP = " — ";
const FIX_BY_HAND_SUFFIX = " (not rendered by Trellis; fix by hand)";
/** `path[:line[:col]]` —— 行/列只认右侧的 `:数字` 形态。 */
const LOCATOR = /^(.*?)(?::(\d+)(?::(\d+))?)?$/;

export interface TomlFindingLocator {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly reason: string;
}

/** 解析 workspace-toml-invalid 的消息 → 路径/行/列/原因;形态不符返回 null。 */
export function parseTomlFindingMessage(message: string): TomlFindingLocator | null {
  const sepAt = message.indexOf(MESSAGE_SEP);
  if (sepAt < 0) return null;
  const loc = message.slice(0, sepAt);
  const reason = message.slice(sepAt + MESSAGE_SEP.length).replace(FIX_BY_HAND_SUFFIX, "");
  const matched = LOCATOR.exec(loc);
  if (matched === null || matched[1] === undefined || matched[1] === "") return null;
  return {
    path: matched[1],
    ...(matched[2] !== undefined ? { line: Number(matched[2]) } : {}),
    ...(matched[3] !== undefined ? { column: Number(matched[3]) } : {}),
    reason,
  };
}

export interface RuleBasedOptions {
  /** 缺省 `rule-<findingId>`;调用方要确定性 id 时注入。 */
  readonly id?: string;
  /** 时间源(毫秒);缺省 Date.now。 */
  readonly now?: () => number;
  /** 读原文注入缝(测试可免写盘);缺省读真实文件。 */
  readonly readFile?: (path: string) => string;
}

/**
 * 对单条检查条目构造 rule-based 提案;没有显而易见机械修复时返回 null。
 * `workspace-toml-invalid`:失败行行首加 `# ` 注释(行已注释/空行时没
 * 有可注释的目标,返回 null 不硬造)。
 */
export function ruleBasedProposal(entry: CheckEntry, options: RuleBasedOptions = {}): Proposal | null {
  if (entry.kind !== "workspace-toml-invalid") return null;
  if (entry.layer.kind !== "workspace") return null;
  const parsed = parseTomlFindingMessage(entry.message);
  if (parsed === null || parsed.line === undefined) return null;
  if (!parsed.path.endsWith(".toml")) return null;

  const read = options.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  let content: string;
  try {
    content = read(parsed.path);
  } catch {
    return null;
  }
  const lines = content.split("\n");
  const index = parsed.line - 1;
  if (parsed.line < 1 || index >= lines.length) return null;
  const original = lines[index] ?? "";
  const trimmed = original.trimStart();
  // 空行或已是注释:没有可注释的失败行(EOF 形态的错误常落在空行)。
  if (trimmed === "" || trimmed.startsWith("#")) return null;

  const fixed = lines.map((line, i) => (i === index ? `# ${original}` : line)).join("\n");
  const layer: SurfaceLayer = entry.layer;
  const evidence: EvidenceLink = { kind: "doctor-finding", findingId: entry.id, layer };
  return {
    id: options.id ?? `rule-${entry.id}`,
    createdAt: (options.now ?? Date.now)(),
    kind: "workspace-config-fix",
    target: parsed.path,
    layer,
    evidence: [evidence],
    // 占位:12.3 按 kind+target 重算,不采信自报。
    riskClass: "B",
    summary: `注释 workspace TOML 解析失败行(${basename(parsed.path)}:${parsed.line})`,
    edits: [{ op: "write-file", path: parsed.path, content: fixed }],
  };
}

export interface RuleBasedProposeOptions {
  readonly signals: readonly Signal[];
  readonly findings: readonly CheckEntry[];
  readonly availability: ProposalChannelAvailability;
  readonly now?: () => number;
  readonly readFile?: (path: string) => string;
}

export interface RuleBasedProposeResult {
  readonly channel: "editor" | "rule-based";
  /** 产出的草稿提案(仍待机械校验与 L1 前闸)。 */
  readonly proposals: readonly Proposal[];
  /** 无法机械修复的 doctor finding(带原因,便于档案/日志)。 */
  readonly skipped: readonly { readonly findingId: string; readonly reason: string }[];
}

/**
 * 信号 → rule-based 提案:只在 rule-based 通道消费 doctor finding 形态
 * 信号(按 stableId 对齐 findings);editor 通道由 editor 产出提案,本
 * 函数不代劳(channel 透传,proposals 为空)。
 */
export function proposeFromSignals(options: RuleBasedProposeOptions): RuleBasedProposeResult {
  const channel = selectProposalChannel(options.availability);
  if (channel === "editor") {
    return { channel, proposals: [], skipped: [] };
  }

  const findingsById = new Map(options.findings.map((entry) => [entry.id, entry]));
  const proposals: Proposal[] = [];
  const skipped: { findingId: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const signal of options.signals) {
    if (!isDoctorFindingSignal(signal)) continue;
    const findingId = signal.stableId;
    if (findingId === null || seen.has(findingId)) continue;
    seen.add(findingId);
    const entry = findingsById.get(findingId);
    if (entry === undefined) {
      skipped.push({ findingId, reason: "信号没有对应的检查条目" });
      continue;
    }
    const proposal = ruleBasedProposal(entry, {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.readFile !== undefined ? { readFile: options.readFile } : {}),
    });
    if (proposal === null) {
      skipped.push({ findingId, reason: `kind "${entry.kind}" 没有显而易见的机械修复` });
      continue;
    }
    proposals.push(proposal);
  }
  return { channel, proposals, skipped };
}
