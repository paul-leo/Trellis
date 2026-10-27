/**
 * L1 doctor-oracle 前闸(trellis-evolve 任务 12.1)。
 *
 * 两副职责:
 *
 * 1. **提案类域分派**:仅 `L1_CONFIG_KINDS` 白名单内的配置类提案进入
 *    提案通道;内容类提案本期不产出(等 L2 选择器执行落地)。design D8
 *    "L1 适用域的判定由 L4 治理层按 kind 白名单执行"——本模块就是该判定
 *    点,12.2 的机械校验对提案 kind 的准入与此同源。
 * 2. **确定性候选 verdict 差集**:对真实 baseline 与 staging 候选各运行
 *    一组结构化检查(doctor findings、`sync --check`、secrets audit),
 *    按 (稳定 id, 层归属) 集合差判定。在 L1 适用域内该差集是**唯一
 *    verdict**,配置类提案不运行引擎评分链。
 *
 * 可采纳判据(design D8,从严):无新条目 ∧ 全部目标条目被消除 ∧ 其余
 * 条目不变(未声明的消除也算变化)。目标条目 = 提案 evidence 中
 * `doctor-finding` 链接的 `findingId`(即 CheckEntry.id);`Proposal.target`
 * 本身是被编辑面的锚点(spec:"目标为某 MCP server auth 块"、"目标路径
 * 位于某仓库的 .agents/ 内"),不是检查条目——两者职责分开,本闸只消费
 * findingId。目标条目不在 baseline 时"无法确认修复",按不采纳收口。
 *
 * staging 复现层分裂:`createStaging` 拷 scratch 全局 HOME + 临时
 * workspace root(墓碑生效),提案 edits 由本模块把真实面绝对路径重定位
 * 到 scratch(越界不采纳);baseline 与候选都带 `logicalWorkspaceRoot`
 * 归一化,条目比较键含层归属(`workspace(<root>)` 与全局不混)。
 *
 * 失败收口(Risks 8):staging/应用/测量任何意外错误一律"不采纳",
 * 测量结果记 `unknown`(空条目集,绝不表示为零分或通过);域外提案同样
 * 不采纳。全部判定都写入运行档案(kind `"verdict"`,含 baseline 与
 * candidate 两份完整测量)。
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { appendArchiveRecord } from "./archive.js";
import type { EvidenceLink, Proposal, Verdict, VerdictEntry } from "./types.js";
import {
  applyEdits,
  createStaging,
  runChecks,
  type ApplyEditsOptions,
  type ApplyEditsResult,
  type CheckResult,
  type CreateStagingOptions,
  type EditOp,
  type RunChecksOptions,
  type Staging,
  type SurfaceLayer,
} from "../host/index.js";

/** 档案 kind:一次 L1 verdict(两份完整测量 + 判定原因)。 */
export const VERDICT_ARCHIVE_KIND = "verdict";

/**
 * L1 适用域:配置类 kind 白名单(design D8)。名单内提案进入提案通道,
 * L1 差集作唯一 verdict;名单外(含内容类——skill/记忆/指令正文等)本
 * 期不产出提案,等 L2 选择器执行落地。命名与 12.2 rule-based/editor
 * 提案的产出侧保持一致。
 */
export const L1_CONFIG_KINDS: ReadonlySet<string> = new Set([
  /** workspace 层配置面修复(如 `.codex/config.toml` 解析错误)。 */
  "workspace-config-fix",
  /** MCP 定义/路由等配置面修复(凭据字面值在校验阶段硬拒)。 */
  "mcp-config-fix",
  /** 托管投递面漂移修复(sync 可见面)。 */
  "sync-config-fix",
  /** secrets 策略配置修复(变量名/拒绝模式,不含任何凭据值)。 */
  "secrets-policy-fix",
  /** OAuth 配置元数据修复(kind/owner/client 元数据,不含凭据)。 */
  "oauth-config-fix",
]);

export interface ProposalDomainDispatch {
  readonly domain: "config" | "content";
  /** 仅配置类进入提案通道;内容类本期不产出。 */
  readonly entersProposalChannel: boolean;
  readonly note: string;
}

/** 提案类域分派:白名单内 = 配置类(进通道),其余 = 内容类(不产出)。 */
export function dispatchProposalDomain(kind: string): ProposalDomainDispatch {
  if (L1_CONFIG_KINDS.has(kind)) {
    return {
      domain: "config",
      entersProposalChannel: true,
      note: `kind "${kind}" 属配置类,进入提案通道(L1 差集为唯一 verdict)`,
    };
  }
  return {
    domain: "content",
    entersProposalChannel: false,
    note: `kind "${kind}" 不在配置类白名单,本期不产出提案(等 L2 选择器执行落地)`,
  };
}

/**
 * 条目比较键:(稳定 id, 层归属)。"条目 SHALL 带着层归属参与比较"——
 * 同一 id 在全局层与 workspace 层是两条不同记录,不互相抵消。
 */
export function entryKey(entry: VerdictEntry): string {
  const layerKey = entry.layer.kind === "global" ? "global" : `workspace(${entry.layer.root})`;
  return `${entry.id} ${layerKey}`;
}

export interface VerdictDiff {
  /** 候选有、baseline 没有(引入的回归)。 */
  readonly introduced: VerdictEntry[];
  /** baseline 有、候选没有(被消除的条目)。 */
  readonly resolved: VerdictEntry[];
}

/** 按 (id, layer) 做集合差;message 不参与比较(host/checks.ts 契约)。 */
export function diffVerdictEntries(
  baseline: readonly VerdictEntry[],
  candidate: readonly VerdictEntry[],
): VerdictDiff {
  const baselineKeys = new Set(baseline.map(entryKey));
  const candidateKeys = new Set(candidate.map(entryKey));
  return {
    introduced: candidate.filter((entry) => !baselineKeys.has(entryKey(entry))),
    resolved: baseline.filter((entry) => !candidateKeys.has(entryKey(entry))),
  };
}

/** 提案 evidence 中的目标条目(evidence 的 doctor-finding.findingId
 * 即 CheckEntry.id;`Proposal.target` 是编辑面锚点,不在此列)。 */
export function doctorFindingTargetIds(evidence: readonly EvidenceLink[]): string[] {
  return evidence
    .filter((link): link is Extract<EvidenceLink, { kind: "doctor-finding" }> => link.kind === "doctor-finding")
    .map((link) => link.findingId);
}

export interface EvaluateL1Options {
  /** 真实面 HOME(档案也写在这里的 `~/.trellis/evolve/`)。 */
  readonly homeDir: string;
  /** 被测上下文的 workspace root;缺省/null = 纯全局上下文。 */
  readonly workspaceRoot?: string | null;
  readonly proposal: Proposal;
  /** 注入缝(场景测试的强制报错收口);缺省走 host 真实实现。 */
  readonly runChecksFn?: (options: RunChecksOptions) => Promise<CheckResult>;
  readonly createStagingFn?: (options: CreateStagingOptions) => Staging;
  readonly applyEditsFn?: (options: ApplyEditsOptions) => Promise<ApplyEditsResult>;
  /** 时间源(毫秒);缺省 Date.now(档案打戳)。 */
  readonly now?: () => number;
}

export interface L1GateResult {
  readonly decision: "acceptable" | "not-acceptable";
  readonly reason: string;
  readonly domain: "config" | "content";
  readonly verdict: Verdict;
  readonly targetIds: readonly string[];
  /** 引入的新条目(不可采纳时入档)。 */
  readonly introduced: readonly VerdictEntry[];
  readonly resolvedIds: readonly string[];
}

function unknownVerdict(layer: SurfaceLayer): Verdict {
  return { status: "unknown", layer, baseline: [], candidate: [] };
}

/** `path` 是否落在某个真实面根之下(不含根本身)。 */
function isInsideRoots(path: string, roots: readonly (string | null)[]): boolean {
  const resolved = resolve(path);
  for (const root of roots) {
    if (!root) continue;
    const rel = relative(resolve(root), resolved);
    if (rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return true;
  }
  return false;
}

/** 真实面绝对路径 → staging scratch 对应路径;越界抛错(不采纳)。
 * workspace 根优先(可能嵌套在 HOME 下,与 checks 的归一化同序)。 */
function relocateIntoStaging(
  path: string,
  ctx: { homeDir: string; workspaceRoot: string | null; staging: Staging },
): string {
  const roots: Array<{ real: string; scratch: string | null }> = [];
  if (ctx.workspaceRoot && ctx.staging.workspaceRoot) {
    roots.push({ real: ctx.workspaceRoot, scratch: ctx.staging.workspaceRoot });
  }
  roots.push({ real: ctx.homeDir, scratch: ctx.staging.homeDir });
  const resolved = resolve(path);
  for (const { real, scratch } of roots) {
    if (!scratch) continue;
    const rel = relative(resolve(real), resolved);
    if (rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      return join(scratch, rel);
    }
  }
  throw new Error(`edit path escapes the measured surface: ${path}`);
}

/** 符号链接 target:落在真实面内才重定位到 scratch(链接不指向真实面);
 * 相对路径与面外绝对路径保持原义(校验阶段的职责不在此)。 */
function relocateTargetIfInside(
  target: string,
  ctx: { homeDir: string; workspaceRoot: string | null; staging: Staging },
): string {
  if (!isAbsolute(target)) return target;
  if (!isInsideRoots(target, [ctx.workspaceRoot, ctx.homeDir])) return target;
  return relocateIntoStaging(target, ctx);
}

function relocateEdits(
  edits: readonly EditOp[],
  ctx: { homeDir: string; workspaceRoot: string | null; staging: Staging },
): EditOp[] {
  return edits.map((edit) => {
    const path = relocateIntoStaging(edit.path, ctx);
    switch (edit.op) {
      case "write-file":
      case "remove-symlink":
        return { ...edit, path };
      case "create-symlink":
      case "repair-symlink":
        return { ...edit, path, target: relocateTargetIfInside(edit.target, ctx) };
    }
  });
}

/**
 * L1 前闸完整判定:域分派 → staging 副本(层分裂复现)→ edits 重定位并
 * 应用 → baseline/候选各跑三组结构化检查 → (id, layer) 差集 → 判定并
 * 入档。任何意外错误按"不采纳"收口、测量记 unknown;不吞掉入档写失败。
 */
export async function evaluateL1Proposal(options: EvaluateL1Options): Promise<L1GateResult> {
  const homeDir = options.homeDir;
  const workspaceRoot = options.workspaceRoot ?? null;
  const proposal = options.proposal;
  const stamp = () => new Date((options.now ?? Date.now)());
  const dispatch = dispatchProposalDomain(proposal.kind);

  const settle = (outcome: {
    decision: "acceptable" | "not-acceptable";
    reason: string;
    verdict: Verdict;
    targetIds: readonly string[];
    introduced: readonly VerdictEntry[];
    resolvedIds: readonly string[];
  }): L1GateResult => {
    const result: L1GateResult = {
      decision: outcome.decision,
      reason: outcome.reason,
      domain: dispatch.domain,
      verdict: outcome.verdict,
      targetIds: outcome.targetIds,
      introduced: outcome.introduced,
      resolvedIds: outcome.resolvedIds,
    };
    // 两份 verdict 入档:baseline 与 candidate 完整条目集 + 判定原因。
    appendArchiveRecord(
      homeDir,
      {
        kind: VERDICT_ARCHIVE_KIND,
        payload: {
          proposalId: proposal.id,
          kind: proposal.kind,
          domain: dispatch.domain,
          decision: outcome.decision,
          reason: outcome.reason,
          status: outcome.verdict.status,
          layer: outcome.verdict.layer,
          targetIds: outcome.targetIds,
          introduced: outcome.introduced,
          resolvedIds: outcome.resolvedIds,
          baseline: outcome.verdict.baseline,
          candidate: outcome.verdict.candidate,
        },
      },
      stamp,
    );
    return result;
  };

  // 域分派:内容类本期不产出(等 L2)——不测量、不通过。
  if (!dispatch.entersProposalChannel) {
    return settle({
      decision: "not-acceptable",
      reason: dispatch.note,
      verdict: unknownVerdict(proposal.layer),
      targetIds: [],
      introduced: [],
      resolvedIds: [],
    });
  }

  const targetIds = doctorFindingTargetIds(proposal.evidence);
  if (targetIds.length === 0) {
    return settle({
      decision: "not-acceptable",
      reason: "提案证据中没有 doctor-finding 目标条目,无法确认修复",
      verdict: unknownVerdict(proposal.layer),
      targetIds: [],
      introduced: [],
      resolvedIds: [],
    });
  }

  const runChecksFn = options.runChecksFn ?? runChecks;
  const createStagingFn = options.createStagingFn ?? createStaging;
  const applyEditsFn = options.applyEditsFn ?? applyEdits;

  let staging: Staging | null = null;
  try {
    staging = createStagingFn({ homeDir, workspaceRoot });
    const edits = relocateEdits(proposal.edits, { homeDir, workspaceRoot, staging });
    if (edits.length > 0) {
      await applyEditsFn({ homeDir: staging.homeDir, edits, command: "evolve-l1-gate" });
    }

    // baseline:真实面;candidate:staging scratch。两侧都带
    // logicalWorkspaceRoot 归一化,scratch 路径不进比较身份。
    const baselineResult = await runChecksFn({
      homeDir,
      workspaceRoot,
      logicalWorkspaceRoot: workspaceRoot,
    });
    const candidateResult = await runChecksFn({
      homeDir: staging.homeDir,
      workspaceRoot: staging.workspaceRoot,
      logicalWorkspaceRoot: staging.logicalWorkspaceRoot,
    });
    const baseline = baselineResult.entries;
    const candidate = candidateResult.entries;
    const diff = diffVerdictEntries(baseline, candidate);
    const targetIdSet = new Set(targetIds);
    const baselineIds = new Set(baseline.map((entry) => entry.id));
    const missingTargets = targetIds.filter((id) => !baselineIds.has(id));
    const targetKeys = new Set(
      baseline.filter((entry) => targetIdSet.has(entry.id)).map(entryKey),
    );
    const resolvedKeys = new Set(diff.resolved.map(entryKey));
    const resolvedIds = diff.resolved.map((entry) => entry.id);

    const okVerdict: Verdict = { status: "ok", layer: proposal.layer, baseline, candidate };
    const common = { verdict: okVerdict, targetIds, introduced: diff.introduced, resolvedIds };

    // 目标条目必须在 baseline 里——不在则"无法确认修复"。
    if (missingTargets.length > 0) {
      return settle({
        ...common,
        decision: "not-acceptable",
        reason: `目标条目不在 baseline(${missingTargets.join(", ")}),无法确认修复`,
      });
    }
    // 无新条目。
    if (diff.introduced.length > 0) {
      return settle({
        ...common,
        decision: "not-acceptable",
        reason: `候选引入 ${diff.introduced.length} 个 baseline 中不存在的新条目`,
      });
    }
    // 目标条目被消除 ∧ 其余不变(未声明的消除也算变化)。
    const targetsAllResolved = [...targetKeys].every((key) => resolvedKeys.has(key));
    const noExtraResolved =
      resolvedKeys.size === targetKeys.size && [...resolvedKeys].every((key) => targetKeys.has(key));
    if (!targetsAllResolved) {
      return settle({ ...common, decision: "not-acceptable", reason: "目标条目未被完全消除" });
    }
    if (!noExtraResolved) {
      return settle({
        ...common,
        decision: "not-acceptable",
        reason: "候选消除了未声明的条目,其余不满足不变约束",
      });
    }
    return settle({
      ...common,
      decision: "acceptable",
      reason: "候选消除全部目标条目,无新条目,其余不变",
    });
  } catch (err) {
    // Risks 8:意外错误一律不采纳,测量记 unknown,绝不表示为通过。
    return settle({
      decision: "not-acceptable",
      reason: `测量/应用失败,按'不采纳'收口: ${err instanceof Error ? err.message : String(err)}`,
      verdict: unknownVerdict(proposal.layer),
      targetIds,
      introduced: [],
      resolvedIds: [],
    });
  } finally {
    staging?.dispose();
  }
}
