/**
 * 自我进化管理面命令(trellis-evolve 任务 12.4)。
 *
 * 消费者归属(8.7):本文件是自我进化子系统的一部分,物理移出消费者时
 * 与 src/evolve/**、CLI 挂载(src/cli.ts 的 CONSUMER_WIRING 接线行)一并
 * 删除;hostingIndependence.test.ts 的 CONSUMER_OWNED/CONSUMER_WIRING
 * 登记了这条移出清单。
 *
 * `trellis evolve <status | report | pending | approve | reject | apply | run | import | enable | disable | rollback>`
 *
 * 批准只走这里,且**仅限交互式终端**(spec"批准只走带外通道"):非交互
 * 环境一律拒绝,提案保持 pending。不存在任何 `--yes` / `--confirm` 之类的
 * 非交互批准捷径 —— agent 传入的"确认"参数不构成批准,加了也只会被当
 * 未知参数忽略。循环副作用边界:除 `run`(唯一命令行触发入口,手动
 * 触发一次运行)外的命令不写信号、不触发观察/提案/probe。approve
 * 决策后**立即应用**(spec"批准即应用与显式应用入口":持单飞作业锁经
 * 备份会话写入,锁忙暂缓并告知);apply 幂等应用全部已批准未应用的编辑
 * (失败重试与滞留消化入口);reject 只做状态迁移 + 档案;enable/disable
 * 写 canonical 级别策略,并按 design 8.1 同步扩展清单条目——级别升至
 * observe 及以上时写入、置回 off 时移除;rollback 转发既有备份会话回滚。
 */

import { homedir } from "node:os";
import {
  classifyManagedObservation,
  HostEditError,
  LEVELS,
  loadEvolveLevelPolicy,
  triggerRenderSync,
  writeEvolveLevelPolicy,
  type EvolveLevelPolicy,
  type Level,
} from "../host/index.js";
import { removeExtensionEntry, upsertExtensionEntry } from "../lib/hostExtensions.js";
import { appendArchiveRecord } from "../evolve/archive.js";
import { EVOLVE_EXTENSION_ID, evolveExtensionLoadSpecifier } from "../evolve/extension.js";
import { ensureEvolveStateDir, ensureStateGitignored } from "../evolve/stateDir.js";
import { importHistory, ImportSourceError } from "../evolve/importHistory.js";
import { runJobShell } from "../evolve/jobShell.js";
import { anyProposalLevel } from "../evolve/jobRun.js";
import { buildEvolveReport, type EvolveReport } from "../evolve/reportView.js";
import { applyApprovedProposals, type ApplyAgent, type ApplyApprovedResult } from "../evolve/apply.js";
import {
  acquireJobLock,
  collectTriggerState,
  evaluateTrigger,
  releaseJobLock,
  resolveTriggerLimits,
  setRunRequest,
  TRIGGER_DECISION_KIND,
} from "../evolve/trigger.js";
import { runRollback } from "./rollback.js";
import {
  decideProposal,
  readPendingRecord,
  readProposalsByStatus,
  type PendingRecord,
  type ProposalDecision,
} from "../evolve/pending.js";

export interface EvolveCommandOptions {
  /** 测试/sandbox 注入缝;缺省用户 HOME。永不作为 CLI 标志暴露。 */
  readonly homeDir?: string;
  /** TTY 检测缝;缺省 stdin+stdout 同时为 TTY。 */
  readonly isTTY?: boolean;
  /** 时间源(毫秒);缺省 Date.now。 */
  readonly now?: () => number;
  /** 应用阶段的 agent 分类(测试/sandbox 注入缝;缺省按 delivery 分类)。 */
  readonly applyAgents?: readonly ApplyAgent[];
  /** 原生渲染同步触发缝(测试注入;缺省 host `triggerRenderSync`)。 */
  readonly triggerSync?: () => Promise<{ exitCode: number }>;
}

const USAGE = [
  "Usage: trellis evolve <subcommand>",
  "",
  "  status [--json]                 级别与提案状态总览(只读,零副作用)",
  "  report [--json]                 进化报告:时间线/前后测量/趋势(只读,零副作用)",
  "  pending                         列出待批提案(摘要/证据/风险级别)",
  "  approve <id>                    批准并应用提案(仅交互式终端;批准即应用)",
  "  reject <id>                     拒绝提案(仅交互式终端)",
  "  apply                           应用全部已批准未应用的提案(幂等;",
  "                                  失败重试与滞留消化入口)",
  "  run [--dry-run]                 手动触发一次运行(唯一命令行触发入口;",
  "                                  跳过阈值/冷却,仍守单飞锁与预算护栏;",
  "                                  dry-run 预览,不拉起不写入)",
  "  import <path>... [--workspace <root>]",
  "                                  导入历史会话数据为观察信号(显式路径、",
  "                                  源只读、台账幂等;不触发任何作业)",
  "  enable [--level <level>]        开启进化(default level,缺省 observe);",
  "                                  同步写入扩展清单条目(observe 及以上)",
  "  disable                         关闭进化(default level = off);移除扩展清单条目",
  "  rollback [runId | --list | --dry-run | --json]",
  "                                  备份会话回滚(同 `trellis rollback`)",
  "",
  "级别:" + LEVELS.join(" | "),
].join("\n");

function printUsage(): void {
  console.log(USAGE);
}

function describeRecord(record: PendingRecord): string {
  const lines = [
    `${record.id}  [${record.status}]  risk=${record.riskClass}(${record.riskRuleId})`,
    `  kind: ${record.proposal.kind}  target: ${record.proposal.target}`,
    `  ${record.proposal.summary}`,
    `  evidence: ${record.proposal.evidence
      .map((link) => {
        const ref =
          link.kind === "run" ? link.runId : link.kind === "doctor-finding" ? link.findingId : link.signalId;
        return `${link.kind}:${ref}`;
      })
      .join("; ")}`,
  ];
  for (const edit of record.proposal.edits) {
    lines.push(`  edit: ${edit.op} ${edit.path}`);
  }
  return lines.join("\n");
}

function isInteractiveTTY(options: EvolveCommandOptions): boolean {
  return options.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function setDefaultLevel(homeDir: string, level: Level): EvolveLevelPolicy {
  const current = loadEvolveLevelPolicy(homeDir);
  const next: EvolveLevelPolicy = {
    defaultLevel: level,
    agents: current.agents,
    workspaces: current.workspaces,
    ...(current.trigger !== undefined ? { trigger: current.trigger } : {}),
  };
  writeEvolveLevelPolicy(homeDir, next);
  return next;
}

/**
 * 按 8.1 定案同步扩展清单条目:任一粒度(default/agent/workspace)升至
 * `observe` 及以上 → 写入(幂等 upsert);全部回到 `off` → 移除。粒度
 * 覆盖场景(如 default off + workspace observe)下条目同样在——订阅者的
 * 逐会话级别判定才是细粒度闸,清单条目只是"可装载"。
 */
function syncEvolveExtensionEntry(homeDir: string, policy: EvolveLevelPolicy): boolean {
  const levels: (Level | undefined)[] = [
    policy.defaultLevel,
    ...Object.values(policy.agents),
    ...Object.values(policy.workspaces),
  ];
  const wanted = levels.some((l) => l === "observe" || l === "propose" || l === "auto-A");
  if (wanted) {
    upsertExtensionEntry(homeDir, { id: EVOLVE_EXTENSION_ID, load: evolveExtensionLoadSpecifier() });
  } else {
    removeExtensionEntry(homeDir, EVOLVE_EXTENSION_ID);
  }
  return wanted;
}

/** status 文本渲染(与 `--json` 同源:同一份 EvolveReport 聚合)。 */
function renderStatusText(report: EvolveReport): void {
  console.log(`default level: ${report.levels.defaultLevel ?? "off"}`);
  for (const [agent, level] of Object.entries(report.levels.agents)) {
    console.log(`agent ${agent}: ${level}`);
  }
  for (const [root, level] of Object.entries(report.levels.workspaces)) {
    console.log(`workspace ${root}: ${level}`);
  }
  console.log(`proposals: ${report.counts.pending} pending, ${report.counts.approved} approved, ${report.counts.rejected} rejected`);
  if (report.counts.approvedUnapplied > 0) {
    console.log(
      `approved 未应用 ${report.counts.approvedUnapplied} 条:运行 \`trellis evolve apply\` 立即写入(或等待下次作业应用阶段)。`,
    );
  }
  if (report.notices.length > 0) {
    console.log("最近的自动采纳通知:");
    for (const notice of report.notices.slice(-3)) console.log(`  ${notice}`);
  }
}

/** report 文本渲染:趋势 + 时间线(数值与 `--json` 同源)。 */
function renderReportText(report: EvolveReport): void {
  const stateLabel =
    report.state === "not-enabled" ? "未开启(未记录任何进化活动)" :
    report.state === "enabled-idle" ? "已开启,尚未运行" : "有运行历史";
  console.log(`状态: ${stateLabel}`);
  console.log("趋势(口径随数据导出,可从档案重算;不含合成评分):");
  for (const metric of report.trends) {
    const value = metric.value === null ? "无测量记录" : Number.isInteger(metric.value) ? String(metric.value) : metric.value.toFixed(3);
    console.log(`  ${metric.label}: ${value}  [来源:${metric.source}]`);
  }
  if (report.jobRuns.length > 0) {
    console.log(`作业运行(${report.jobRuns.length} 次):`);
    for (const run of report.jobRuns) {
      const label = run.trigger === "manual" ? "手动" : run.trigger === "chain" ? "补跑" : "事件";
      console.log(`  ${run.startedAt}  [${label}]  ${run.ok ? "ok" : `error: ${run.error ?? "?"}`}`);
    }
  }
  if (report.timeline.length === 0) {
    console.log("提案时间线: 空(尚无提案)");
  } else {
    console.log("提案时间线:");
    for (const trace of report.timeline) {
      console.log(`  ${trace.id}  [${trace.status}]  ${trace.summary}`);
      for (const step of trace.chain) console.log(`    - ${step.at}  ${step.stage}: ${step.note}`);
      if (trace.measurement === null) {
        console.log("    测量: 无测量记录(未推断)");
      } else {
        const m = trace.measurement;
        console.log(
          `    测量: ${m.decision} — 消除 ${m.resolvedIds.length}/${m.targetIds.length},新引入 ${m.introduced.length}` +
            `(${m.reason})`,
        );
      }
      if (trace.backupRunId !== null) console.log(`    回滚: trellis evolve rollback ${trace.backupRunId}`);
    }
  }
}

async function runDecision(
  homeDir: string,
  id: string,
  decision: ProposalDecision,
  options: EvolveCommandOptions,
): Promise<number> {
  if (id === undefined || id === "") {
    console.error(`trellis evolve: ${decision === "approved" ? "approve" : "reject"} 需要提案 id`);
    console.error(USAGE);
    return 1;
  }
  // 批准只走带外通道:非交互环境(含 agent 脚本)一律拒绝,提案保持
  // pending。任何 --yes/--confirm 之类参数不构成批准(未知参数忽略)。
  if (!isInteractiveTTY(options)) {
    console.error(
      `trellis evolve: ${decision === "approved" ? "批准" : "拒绝"}仅限交互式终端。` +
        "非交互环境不接受任何确认参数,提案保持 pending。",
    );
    return 1;
  }
  const result = decideProposal({
    homeDir,
    id,
    decision,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  if (!result.ok) {
    if (result.error === "not-found") {
      console.error(`trellis evolve: 提案 ${id} 不存在`);
    } else {
      const current = readPendingRecord(homeDir, id);
      console.error(`trellis evolve: 提案 ${id} 已决策(${current?.status ?? "?"}),不重复决策`);
    }
    return 1;
  }
  if (decision === "approved") {
    console.log(`已批准提案 ${id}(risk=${result.record.riskClass});批准即应用。`);
    return await applyApprovedAndReport(homeDir, options);
  }
  console.log(`已拒绝提案 ${id}。`);
  return 0;
}

/**
 * 应用全部已批准未应用的提案并汇报(spec"批准即应用与显式应用入口")。
 * 与作业应用阶段互斥:复用单飞作业锁防并发双写;锁忙时暂缓并如实告知
 * (决策已完成、提案保持 approved,由本入口或作业应用阶段收尾)。
 */
async function applyApprovedAndReport(homeDir: string, options: EvolveCommandOptions): Promise<number> {
  const agents: readonly ApplyAgent[] =
    options.applyAgents ??
    classifyManagedObservation(homeDir).map((entry) => ({
      agent: entry.agent,
      observation: entry.observation,
    }));
  const triggerSync = options.triggerSync ?? (async () => await triggerRenderSync({ homeDir }));
  if (!acquireJobLock(homeDir, process.pid, Date.now())) {
    console.log(
      "已有作业在运行:本次应用暂缓(决策已完成,提案保持 approved)。" +
        "作业的应用阶段会写入,也可稍后运行 `trellis evolve apply`。",
    );
    return 0;
  }
  try {
    const result = await applyApprovedProposals({ homeDir, agents, triggerSync });
    return renderApplyResult(result);
  } catch (err) {
    if (err instanceof HostEditError) {
      console.error(`应用部分失败:${err.message}`);
      console.error(
        `已应用部分可回滚:trellis evolve rollback ${err.runId}。` +
          "提案保持 approved,可经 `trellis evolve apply` 重试(编辑幂等重放)。",
      );
      return 1;
    }
    throw err;
  } finally {
    releaseJobLock(homeDir, process.pid);
  }
}

function renderApplyResult(result: ApplyApprovedResult): number {
  for (const id of result.skippedInvalidIds) {
    console.log(`跳过 ${id}:应用前重校验不通过(pending 磁盘状态漂移?),未写入。`);
  }
  if (result.appliedProposalIds.length === 0) {
    console.log(
      result.alreadyAppliedIds.length > 0
        ? "没有已批准未应用的提案(已应用过的不重复写入)。"
        : "没有已批准未应用的提案。",
    );
    return 0;
  }
  console.log(`已应用 ${result.appliedProposalIds.length} 条提案:${result.appliedProposalIds.join(", ")}。`);
  console.log(`备份会话 ${result.runId}。回滚:trellis evolve rollback ${result.runId}`);
  for (const effect of result.effects) {
    console.log(`生效时点 ${effect.agent}(${effect.observation}):${effect.effect}`);
  }
  if (result.syncError !== null) {
    console.log(`注意:渲染同步触发失败:${result.syncError};可手动运行 \`trellis sync\`。`);
  }
  return 0;
}

/**
 * 手动触发一次运行(`trellis evolve run`;run-backfill D1/D2)。唯一命令
 * 行触发入口:阈值/冷却豁免(用户明确意图),单飞锁与预算护栏照旧;
 * `--dry-run` 只预览(零副作用:不抢锁、不写档案);observe 及以下作业体
 * 零副作用早退并说明级别与调整方法。不设 TTY 门——手动触发是显式动作,
 * 输出走 stdout。
 */
async function runManualJob(homeDir: string, dryRun: boolean, options: EvolveCommandOptions): Promise<number> {
  const now = options.now ?? Date.now;
  const policy = loadEvolveLevelPolicy(homeDir);
  if (!anyProposalLevel(policy)) {
    console.log(
      `当前级别 ${policy.defaultLevel ?? "off"}:作业体零副作用早退(observe 只采集信号,off 关闭)。` +
        "要手动运行作业体,先 `trellis evolve enable --level propose`(或 auto-A)。",
    );
    return 0;
  }
  const limits = resolveTriggerLimits(policy.trigger);
  const state = collectTriggerState(homeDir, now());
  const gate = evaluateTrigger(state, limits, { threshold: true, cooldown: true });

  if (dryRun) {
    console.log("dry-run:预览本次手动触发(不拉起作业、不写入任何状态)。");
    console.log(`  累计信号:${state.pendingSignalCount}`);
    console.log(
      `  护栏判定:${gate.decision === "launch" ? "将运行(阈值/冷却已豁免,预算未超限)" : `将跳过(${gate.reason}):${gate.note}`}`,
    );
    return 0;
  }

  if (gate.decision === "skip") {
    let note = gate.note;
    if (gate.reason === "already-running") {
      setRunRequest(homeDir, "trigger:manual", now());
      note += ";已置补跑标记(当前作业收尾后补跑至多一次)";
    }
    appendArchiveRecord(
      homeDir,
      { kind: TRIGGER_DECISION_KIND, payload: { decision: "skip", reason: gate.reason, note, trigger: "manual" } },
      () => new Date(now()),
    );
    console.log(`本次运行被跳过(${gate.reason}):${note}`);
    return 0;
  }

  const result = await runJobShell(homeDir, { trigger: "manual", now });
  if (result.status === "lock-busy") {
    // 竞态窗口:门检通过后另有作业抢到锁 → 与运行中触发同语义,置补跑标记。
    setRunRequest(homeDir, "trigger:manual", now());
    console.log("已有作业在运行(竞态窗口):本次运行未启动,已置补跑标记(当前作业收尾后补跑至多一次)。");
    return 0;
  }
  if (result.status === "error") {
    console.error(`作业体失败:${result.message}(运行档案已记录错误,可重试)。`);
    return 1;
  }
  const s = result.summary;
  console.log(
    `作业完成:信号 ${s.signalsConsidered} 条、提案 ${s.enqueuedIds.length} 条待批、` +
      `自动采纳 ${s.autoAdoptedIds.length} 条、应用 ${s.applied.appliedProposalIds.length} 条。`,
  );
  for (const notice of s.notices) console.log(`  ${notice}`);
  console.log("运行档案已记录(trigger=manual)。");
  return 0;
}

/**
 * 历史数据导入(`trellis evolve import`;run-backfill D4)。仅处理用户
 * 显式选定的源路径、对源只读;整批先校验后写入(任何源不可解析即非零
 * 退出且零写入);台账幂等(重复导入为空操作);导入不触发任何作业。
 */
function runImport(homeDir: string, paths: readonly string[], workspaceRoot: string | undefined): number {
  if (paths.length === 0) {
    console.error("trellis evolve import: 需要至少一个源路径(仅处理显式选定的文件,不扫描目录)");
    return 1;
  }
  try {
    const result = importHistory({ homeDir, paths, ...(workspaceRoot !== undefined ? { workspaceRoot } : {}) });
    for (const source of result.sources) {
      if (source.duplicate) {
        console.log(`跳过 ${source.path}:已导入过(台账记账,空操作)。`);
        continue;
      }
      console.log(
        `导入 ${source.path}:${source.entries} 条信号(坏行跳过 ${source.badLines},无工具名记录跳过 ${source.skippedNoTool})。`,
      );
    }
    console.log(
      `共写入 ${result.written} 条观察信号,台账已记账(重复导入为空操作)。` +
        "导入不触发作业,信号待后续作业按水位线消费。",
    );
    return 0;
  } catch (err) {
    if (err instanceof ImportSourceError) {
      console.error(`trellis evolve import: ${err.message}`);
      console.error("本次导入零写入(信号存储与台账保持不变)。");
      return 1;
    }
    throw err;
  }
}

/**
 * 管理面命令入口。`args` 为 `evolve` 之后的 argv(子命令 + 参数),
 * 由 cli 原样传入 —— 不经 shell 拼接。
 */
export async function runEvolveCommand(
  args: readonly string[],
  options: EvolveCommandOptions = {},
): Promise<{ exitCode: number }> {
  const homeDir = options.homeDir ?? homedir();
  const [subcommand, ...rest] = args;

  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    printUsage();
    return { exitCode: subcommand === undefined ? 1 : 0 };
  }

  try {
    if (subcommand === "status" || subcommand === "report") {
      // 只读出口:同一份 buildEvolveReport 聚合,文本/JSON 两副渲染壳。
      const report = buildEvolveReport(homeDir);
      const json = rest.includes("--json");
      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else if (subcommand === "status") {
        renderStatusText(report);
      } else {
        renderReportText(report);
      }
      return { exitCode: 0 };
    }

    if (subcommand === "pending") {
      const pending = readProposalsByStatus(homeDir, "pending");
      if (pending.length === 0) {
        console.log("没有待批提案。");
        return { exitCode: 0 };
      }
      for (const record of pending) console.log(describeRecord(record) + "\n");
      return { exitCode: 0 };
    }

    if (subcommand === "approve" || subcommand === "reject") {
      const id = rest.find((arg) => !arg.startsWith("-"));
      return {
        exitCode: await runDecision(
          homeDir,
          id ?? "",
          subcommand === "approve" ? "approved" : "rejected",
          options,
        ),
      };
    }

    if (subcommand === "apply") {
      return { exitCode: await applyApprovedAndReport(homeDir, options) };
    }

    if (subcommand === "run") {
      return { exitCode: await runManualJob(homeDir, rest.includes("--dry-run"), options) };
    }

    if (subcommand === "import") {
      const wsIdx = rest.indexOf("--workspace");
      const workspaceRoot = wsIdx >= 0 ? rest[wsIdx + 1] : undefined;
      if (wsIdx >= 0 && (workspaceRoot === undefined || workspaceRoot.startsWith("-"))) {
        console.error("trellis evolve import: --workspace 需要 workspace 根路径");
        return { exitCode: 1 };
      }
      const paths = rest.filter((arg, i) => !arg.startsWith("-") && (wsIdx < 0 || i !== wsIdx + 1));
      return { exitCode: runImport(homeDir, paths, workspaceRoot) };
    }

    if (subcommand === "enable" || subcommand === "disable") {
      const levelAt = rest.indexOf("--level");
      if (subcommand === "disable" && levelAt >= 0) {
        console.error("trellis evolve: disable 不接受 --level(关闭即 default off;调整级别用 enable --level)");
        return { exitCode: 1 };
      }
      let level: Level = subcommand === "enable" ? "observe" : "off";
      if (levelAt >= 0) {
        const raw = rest[levelAt + 1];
        if (raw === undefined || !(LEVELS as readonly string[]).includes(raw)) {
          console.error(`trellis evolve: --level 必须是 ${LEVELS.join(" | ")}`);
          return { exitCode: 1 };
        }
        level = raw as Level;
      }
      // 自治升级与批准同级闸门:propose/auto-A 会产出甚至自动应用编辑,
      // 只限交互式终端——非交互的 agent 会话不得自行提升自治级别
      // (observe 只采集信号,不设门)。
      if (subcommand === "enable" && (level === "propose" || level === "auto-A") && !isInteractiveTTY(options)) {
        console.error(
          `trellis evolve: 升至 ${level} 仅限交互式终端(与批准同级闸门)。` +
            "非交互环境请先 enable 到 observe。",
        );
        return { exitCode: 1 };
      }
      const policy = setDefaultLevel(homeDir, level);
      let gitignoreNote: string | null = null;
      if (subcommand === "enable") {
        ensureEvolveStateDir(homeDir);
        // 状态根在 git work tree 内(如 dotfiles 仓库)时把 evolve/ 加入
        // .gitignore:只追加状态(信号/pending)不进版本库。
        if (ensureStateGitignored(homeDir) === "added") {
          gitignoreNote = "已把 evolve/ 加入 .trellis/.gitignore(只追加状态不进版本库)。";
        }
      }
      const entryPresent = syncEvolveExtensionEntry(homeDir, policy);
      console.log(
        subcommand === "enable"
          ? `已开启自我进化(default level: ${policy.defaultLevel ?? "off"})。`
          : "已关闭自我进化(default level: off)。",
      );
      console.log(
        entryPresent
          ? `扩展清单条目 "${EVOLVE_EXTENSION_ID}" 已写入(observe 及以上:gateway 会话将装载观察/触发订阅者)。`
          : `扩展清单条目 "${EVOLVE_EXTENSION_ID}" 已移除(全部级别为 off)。`,
      );
      if (gitignoreNote !== null) console.log(gitignoreNote);
      if (subcommand === "disable" && entryPresent) {
        const overrides = [
          ...Object.entries(policy.agents).map(([agent, l]) => `agent ${agent}=${l}`),
          ...Object.entries(policy.workspaces).map(([root, l]) => `workspace ${root}=${l}`),
        ];
        console.log(`注意:仍存在非 off 覆盖(${overrides.join(", ")}),这些粒度上进化仍在生效。`);
      }
      return { exitCode: 0 };
    }

    if (subcommand === "rollback") {
      const list = rest.includes("--list");
      const dryRun = rest.includes("--dry-run");
      const json = rest.includes("--json");
      const runId = rest.find((arg) => !arg.startsWith("-"));
      return await runRollback({
        ...(runId !== undefined ? { runId } : {}),
        list,
        dryRun,
        json,
        homeDir,
      });
    }

    console.error(`trellis evolve: 未知子命令 "${subcommand}"`);
    printUsage();
    return { exitCode: 1 };
  } catch (err) {
    console.error(`trellis evolve: ${(err as Error).message}`);
    return { exitCode: 1 };
  }
}
