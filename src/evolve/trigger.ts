/**
 * 会话触发器(trellis-evolve 任务 11.5/11.6)。
 *
 * 环境式接入的"重活拉起"侧:阈值/冷却/预算判断通过后,一次性 detached
 * 作业(即移植引擎的运行)被拉起,作业结束即退出——系统不依赖常驻进程。
 * 单实例靠作业锁文件 `evolve/job.lock`(作业自身持有,拉起前检查活锁);
 * 预算(每日提案上限、委派 editor 预算)超限即跳过并把原因记入运行档案,
 * 不排队。阈值/冷却/预算上限在 `evolve.yaml` 的 `trigger:` 段可配置
 * (host/levels.ts 解析),缺省值见 `DEFAULT_TRIGGER_LIMITS`。
 *
 * 两个入口共用同一判定(11.6 的补偿评估):会话结束(`maybeLaunchOnSessionEnd`)
 * 与会话启动(`maybeLaunchOnSessionStart`)——SIGKILL/崩溃不发结束事件,
 * 启动路径对上次遗漏的触发做补偿,不会重复消费(累计信号以"上次作业的
 * 信号合并时刻"为界,作业运行期间到达的信号不会被漏掉)。`enabled` 为 false(级别 off)时零副作用:不判定、不入档、不拉起。
 *
 * 判定纯函数是 `evaluateTrigger`;`tryLaunchJob` 负责收集状态(信号、
 * 档案、锁)、判定、spawn、把判定写入档案。拉起的作业入口是
 * `jobMain.ts`(作业体是 rule-based 治理流水的一次运行;引擎内核 golden
 * 锚定但生产未消费,待 L2/探针任务集接入)。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendArchiveRecord, readArchiveRecords, type ArchiveEntry } from "./archive.js";
import { readSignals } from "./recorder.js";
import { evolveStateDir } from "./stateDir.js";
import type { EvolveTriggerLimits } from "../host/levels.js";

/** 档案 kind:一次触发判定(含跳过原因)。 */
export const TRIGGER_DECISION_KIND = "trigger-decision";
/** 档案 kind:一次作业运行(jobMain 结束时落一条,含起止时间)。 */
export const JOB_RUN_KIND = "job-run";
/** 档案 kind:提案(12.x 的提案写入用同一 kind,预算判断据此计数)。 */
export const PROPOSAL_ARCHIVE_KIND = "proposal";
/** 档案 kind:一次委派 editor 调用(预算判断据此计数)。 */
export const EDITOR_CALL_ARCHIVE_KIND = "editor-call";

/** 解析后的触发/预算上限(全部字段已回退到缺省)。 */
export interface ResolvedTriggerLimits {
  readonly signalThreshold: number;
  readonly cooldownMinutes: number;
  readonly dailyProposalCap: number;
  readonly editorBudget: number;
}

/** 缺省触发/预算上限(用户可在 `evolve.yaml` 的 `trigger:` 段覆盖)。
 * 保守取值:冷却 6 小时、每日提案 3 条、editor 预算 5 次。 */
export const DEFAULT_TRIGGER_LIMITS: ResolvedTriggerLimits = {
  signalThreshold: 10,
  cooldownMinutes: 360,
  dailyProposalCap: 3,
  editorBudget: 5,
};

export function resolveTriggerLimits(limits: EvolveTriggerLimits | undefined): ResolvedTriggerLimits {
  return {
    signalThreshold: limits?.signalThreshold ?? DEFAULT_TRIGGER_LIMITS.signalThreshold,
    cooldownMinutes: limits?.cooldownMinutes ?? DEFAULT_TRIGGER_LIMITS.cooldownMinutes,
    dailyProposalCap: limits?.dailyProposalCap ?? DEFAULT_TRIGGER_LIMITS.dailyProposalCap,
    editorBudget: limits?.editorBudget ?? DEFAULT_TRIGGER_LIMITS.editorBudget,
  };
}

export type TriggerSkipReason =
  | "below-threshold"
  | "cooldown"
  | "already-running"
  | "daily-proposal-cap"
  | "editor-budget"
  | "spawn-failed";

/** 触发来源(run-backfill D1/D2):事件触发 / 手动触发 / 补跑链起。
 * 进 trigger-decision 与 job-run 档案;jobMain 经 `--trigger` 透传。 */
export type JobTriggerKind = "event" | "manual" | "chain";

/**
 * 门豁免(纯输入;run-backfill D2):手动/补跑路径绕过信号阈值与冷却
 * (用户明确意图),预算护栏(日提案上限/editor 预算)不豁免。缺省全
 * false —— 事件路径语义逐字不变。
 */
export interface TriggerBypass {
  readonly threshold?: boolean;
  readonly cooldown?: boolean;
}

export type TriggerGateDecision =
  | { readonly decision: "launch"; readonly note: string }
  | { readonly decision: "skip"; readonly reason: TriggerSkipReason; readonly note: string };

export type TriggerDecision =
  | { readonly decision: "launch"; readonly note: string; readonly pid: number }
  | { readonly decision: "skip"; readonly reason: TriggerSkipReason; readonly note: string };

/** 判定所需的全部状态(纯输入,便于单测)。 */
export interface TriggerState {
  readonly now: number;
  /** 累计未消费信号数(自上次作业结束以来)。 */
  readonly pendingSignalCount: number;
  /** 上一作业结束时刻(ms);从未跑过作业为 null(无冷却约束)。 */
  readonly lastJobEndedAt: number | null;
  /** 是否已有作业在运行(活锁)。 */
  readonly jobRunning: boolean;
  /** 当日提案数(按 UTC 日历日,下同)。 */
  readonly todayProposalCount: number;
  /** 当日委派 editor 调用数。 */
  readonly todayEditorCallCount: number;
}

/**
 * 阈值/冷却/预算判断(纯函数)。顺序:活锁 → 阈值 → 冷却 → 每日提案
 * 上限 → editor 预算;全过才 launch。信号"严重度"加权留待提案阶段细化
 * (信号暂无严重度字段,本期按计数)。`bypass` 缺省全 false:事件路径
 * 语义逐字不变;手动/补跑路径豁免阈值与冷却(D2),预算不豁免。
 */
export function evaluateTrigger(
  state: TriggerState,
  limits: ResolvedTriggerLimits,
  bypass: TriggerBypass = {},
): TriggerGateDecision {
  if (state.jobRunning) {
    return { decision: "skip", reason: "already-running", note: "已有作业在运行,不启动第二个" };
  }
  if (bypass.threshold !== true && (state.pendingSignalCount === 0 || state.pendingSignalCount < limits.signalThreshold)) {
    return {
      decision: "skip",
      reason: "below-threshold",
      note: `累计信号 ${state.pendingSignalCount} 未达阈值 ${limits.signalThreshold}`,
    };
  }
  if (bypass.cooldown !== true && state.lastJobEndedAt !== null) {
    const elapsed = state.now - state.lastJobEndedAt;
    const cooldownMs = limits.cooldownMinutes * 60_000;
    if (elapsed < cooldownMs) {
      return {
        decision: "skip",
        reason: "cooldown",
        note: `距上一作业结束 ${Math.round(elapsed / 60_000)} 分钟,仍在冷却期 ${limits.cooldownMinutes} 分钟内`,
      };
    }
  }
  if (state.todayProposalCount >= limits.dailyProposalCap) {
    return {
      decision: "skip",
      reason: "daily-proposal-cap",
      note: `当日提案数 ${state.todayProposalCount} 已达上限 ${limits.dailyProposalCap},跳过不排队`,
    };
  }
  if (state.todayEditorCallCount >= limits.editorBudget) {
    return {
      decision: "skip",
      reason: "editor-budget",
      note: `当日 editor 调用 ${state.todayEditorCallCount} 已达预算 ${limits.editorBudget},跳过不排队`,
    };
  }
  const waived = [bypass.threshold === true ? "阈值" : null, bypass.cooldown === true ? "冷却" : null].filter(
    (part): part is string => part !== null,
  );
  return {
    decision: "launch",
    note:
      waived.length > 0
        ? `累计信号 ${state.pendingSignalCount};${waived.join("与")}判断已豁免,预算未超限`
        : `累计信号 ${state.pendingSignalCount} 达阈值 ${limits.signalThreshold},不在冷却期且预算未超限`,
  };
}

// ---------- 作业锁(单实例) ----------

export function jobLockPath(homeDir: string): string {
  return join(evolveStateDir(homeDir), "job.lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM:进程存在但不属本用户,视为活。
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 是否有活作业在运行;死锁/坏锁顺手清除(下次拉起可进行)。 */
export function isJobRunning(homeDir: string): boolean {
  const path = jobLockPath(homeDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return false;
  }
  let pid: unknown;
  try {
    pid = (JSON.parse(raw) as { pid?: unknown }).pid;
  } catch {
    pid = undefined;
  }
  if (typeof pid === "number" && pid > 0 && pidAlive(pid)) return true;
  // compare-and-delete:判定死锁到 unlink 之间,另一进程可能已完成清理
  // 并用 wx 重建了活锁;重读比对,内容变了视为活锁,绝不误删(否则
  // 随后自己的 wx 成功 → 双作业并发)。
  try {
    if (readFileSync(path, "utf-8") !== raw) return true;
    unlinkSync(path);
  } catch {
    // 并发清锁,忽略。
  }
  return false;
}

/** 作业侧权威抢锁(wx 原建);活锁存在时返回 false,死锁清除后重试一次。 */
export function acquireJobLock(homeDir: string, pid: number, startedAtMs: number): boolean {
  const path = jobLockPath(homeDir);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ pid, startedAtMs }), { flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (isJobRunning(homeDir)) return false;
      // isJobRunning 已清死锁,循环重试一次。
    }
  }
  return false;
}

/** 释放自己持有的锁;不是自己的锁不动。 */
export function releaseJobLock(homeDir: string, pid: number): void {
  const path = jobLockPath(homeDir);
  try {
    const held = (JSON.parse(readFileSync(path, "utf-8")) as { pid?: unknown }).pid;
    if (held !== pid) return;
    unlinkSync(path);
  } catch {
    // 无锁可释(或并发释放),忽略。
  }
}

// ---------- 补跑标记(单槽 coalesce;run-backfill D3) ----------

/** 补跑标记记录(`evolve/run-request.json`):运行期间到达的触发请求
 * 合并为至多一个标记;count 仅审计(多次请求塌缩为一次)。 */
export interface RunRequestRecord {
  readonly reason: string;
  readonly setAtMs: number;
  readonly count: number;
}

export function runRequestPath(homeDir: string): string {
  return join(evolveStateDir(homeDir), "run-request.json");
}

/** 置位幂等:已存在只增 count(审计),reason/setAtMs 保持首次(0600/0700
 * 与信号文件同款;不引入常驻进程与队列)。 */
export function setRunRequest(homeDir: string, reason: string, nowMs: number): RunRequestRecord {
  const path = runRequestPath(homeDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const existing = readRunRequestRaw(path);
  const record: RunRequestRecord =
    existing === null
      ? { reason, setAtMs: nowMs, count: 1 }
      : { reason: existing.reason, setAtMs: existing.setAtMs, count: existing.count + 1 };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

/** CAS 读后删消费(与 isJobRunning 的 compare-and-delete 同款):读后内容
 * 变了视为并发置位的新请求,不误删(留待作业启动清标记/下次收尾消费);
 * 无标记返回 null。 */
export function consumeRunRequest(homeDir: string): RunRequestRecord | null {
  const path = runRequestPath(homeDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const record = parseRunRequestRaw(raw);
  try {
    if (readFileSync(path, "utf-8") !== raw) return record;
    unlinkSync(path);
  } catch {
    // 并发消费/置位竞态,忽略。
  }
  return record;
}

function readRunRequestRaw(path: string): RunRequestRecord | null {
  try {
    return parseRunRequestRaw(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function parseRunRequestRaw(raw: string): RunRequestRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RunRequestRecord>;
    if (
      typeof parsed.reason === "string" &&
      typeof parsed.setAtMs === "number" &&
      typeof parsed.count === "number"
    ) {
      return { reason: parsed.reason, setAtMs: parsed.setAtMs, count: parsed.count };
    }
  } catch {
    // 损坏标记按无标记处理(消费时被删除)。
  }
  return null;
}

// ---------- 状态收集 ----------

/** 自 sinceMs(含:null = 全部)以来的累计信号数(遍历 signals/ 全部进程文件)。 */
export function countPendingSignals(homeDir: string, sinceMs: number | null): number {
  const dir = join(evolveStateDir(homeDir), "signals");
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    for (const signal of readSignals(join(dir, name))) {
      if (sinceMs === null || signal.collectedAt > sinceMs) count++;
    }
  }
  return count;
}

function lastJobEndedAtMs(entries: readonly ArchiveEntry[]): number | null {
  let max: number | null = null;
  for (const entry of entries) {
    if (entry.kind !== JOB_RUN_KIND) continue;
    const ended = (entry.payload as { endedAtMs?: unknown } | null)?.endedAtMs;
    if (typeof ended === "number" && (max === null || ended > max)) max = ended;
  }
  return max;
}

/**
 * 信号消费水位线:优先作业落档的"信号合并时刻"(signalsMergedAtMs)
 * ——用 endedAtMs 会把作业运行期间到达的信号永久漏掉(本次没读到、
 * 下次又被 `collectedAt > endedAtMs` 过滤);旧档案无该字段时回退
 * endedAtMs。冷却期语义仍用 lastJobEndedAtMs(距作业结束)。
 */
export function lastSignalWatermarkMs(entries: readonly ArchiveEntry[]): number | null {
  let max: number | null = null;
  for (const entry of entries) {
    if (entry.kind !== JOB_RUN_KIND) continue;
    const payload = entry.payload as { signalsMergedAtMs?: unknown; endedAtMs?: unknown } | null;
    const watermark =
      typeof payload?.signalsMergedAtMs === "number"
        ? payload.signalsMergedAtMs
        : typeof payload?.endedAtMs === "number"
          ? payload.endedAtMs
          : null;
    if (watermark !== null && (max === null || watermark > max)) max = watermark;
  }
  return max;
}

function countToday(entries: readonly ArchiveEntry[], kind: string, nowMs: number): number {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return entries.filter((entry) => entry.kind === kind && entry.recordedAt.slice(0, 10) === day).length;
}

// ---------- 拉起 ----------

export interface TryLaunchJobOptions {
  homeDir: string;
  /** 级别开关(off 返回 null 且零副作用)。缺省恒开。 */
  enabled?: () => boolean;
  /** 触发/预算上限;缺省走内置默认(调用方可从 evolve.yaml 读入)。 */
  limits?: EvolveTriggerLimits;
  /** 时间源(毫秒);缺省 Date.now。 */
  now?: () => number;
  /** 显式累计信号数;缺省统计自上次作业结束以来的信号。 */
  pendingSignalCount?: number;
  /** 门豁免(手动/补跑路径;缺省不豁免,事件路径语义逐字不变)。 */
  bypass?: TriggerBypass;
  /** 触发来源(入 trigger-decision 与 job-run 档案;缺省 "event")。 */
  trigger?: JobTriggerKind;
  /** 作业命令(argv 传参,不拼 shell);缺省本包 `jobMain.js` 入口。 */
  jobCommand?: { readonly bin: string; readonly args: readonly string[] };
  /** 测试注入的 spawn;缺省 `node:child_process.spawn`。 */
  spawnFn?: (bin: string, args: readonly string[], options: { detached: true; stdio: "ignore" }) => { pid?: number; unref?: () => void; on?: (event: string, listener: () => void) => void };
}

/** 收集判定状态(tryLaunchJob 与 CLI 手动触发的护栏/dry-run 判断同源)。 */
export function collectTriggerState(homeDir: string, nowMs: number, pendingSignalCount?: number): TriggerState {
  const entries = readArchiveRecords(homeDir);
  const lastJobEndedAt = lastJobEndedAtMs(entries);
  return {
    now: nowMs,
    pendingSignalCount: pendingSignalCount ?? countPendingSignals(homeDir, lastSignalWatermarkMs(entries)),
    lastJobEndedAt,
    jobRunning: isJobRunning(homeDir),
    todayProposalCount: countToday(entries, PROPOSAL_ARCHIVE_KIND, nowMs),
    todayEditorCallCount: countToday(entries, EDITOR_CALL_ARCHIVE_KIND, nowMs),
  };
}

/**
 * 完整判断与拉起:收集状态 → `evaluateTrigger` → 判定无论 launch/skip
 * 都只追加入档(跳过必带原因);launch 时 spawn 一次性 detached 作业并
 * 立即 unref(gateway 不等作业,作业崩溃不波及会话;exit 监听只为回收
 * 子进程,不留僵尸)。`enabled` 为 false 时返回 null 且零副作用。
 */
export function tryLaunchJob(options: TryLaunchJobOptions): TriggerDecision | null {
  if (options.enabled !== undefined && !options.enabled()) return null;
  const now = options.now ?? Date.now;
  const nowMs = now();
  const limits = resolveTriggerLimits(options.limits);
  const trigger: JobTriggerKind = options.trigger ?? "event";
  const state = collectTriggerState(options.homeDir, nowMs, options.pendingSignalCount);
  const gate = evaluateTrigger(state, limits, options.bypass ?? {});
  const stamp = () => new Date(nowMs);

  if (gate.decision === "skip") {
    // 运行中触发(手动或事件)→ 置补跑标记(D3:多次请求塌缩为一个);
    // 其余跳过原因(预算等)只记因不置标记(超限不排队的语义不变)。
    let note = gate.note;
    if (gate.reason === "already-running") {
      setRunRequest(options.homeDir, `trigger:${trigger}`, nowMs);
      note += ";已置补跑标记(当前作业收尾后补跑至多一次)";
    }
    appendArchiveRecord(
      options.homeDir,
      { kind: TRIGGER_DECISION_KIND, payload: { decision: "skip", reason: gate.reason, note, trigger } },
      stamp,
    );
    return { decision: "skip", reason: gate.reason, note };
  }

  const command = options.jobCommand ?? defaultJobCommand();
  const spawnFn =
    options.spawnFn ??
    ((bin, args, opts) => spawn(bin, [...args], opts) as unknown as ReturnType<NonNullable<TryLaunchJobOptions["spawnFn"]>>);
  // 触发来源透传给 jobMain(--trigger 入 job-run 档案);event 为缺省不加参。
  const triggerArgs = trigger === "event" ? [] : ["--trigger", trigger];
  const child = spawnFn(command.bin, [...command.args, ...triggerArgs, options.homeDir], { detached: true, stdio: "ignore" });
  // spawn 失败收容:ChildProcess 的 error 事件(EMFILE/ENOMEM 等)异步
  // 触发且无监听者时被 Node 抛成 uncaughtException——本调用点在 bus.emit
  // 的收容之外,会直接打垮 gateway 进程。监听即收容(失败作业不持锁,
  // 下次触发按既有判定重试)。
  child.on?.("error", () => {});
  child.on?.("exit", () => {
    // 仅回收子进程(unref 不阻止事件循环退出);作业退出后锁由 jobMain 自清。
  });
  child.unref?.();
  // pid 缺失 = 拉起失败:不记 launch(否则档案对一次根本没发生的作业说谎)。
  if (typeof child.pid !== "number") {
    const note = `作业进程拉起失败(${command.bin} 未获得 pid),本次不排队`;
    appendArchiveRecord(
      options.homeDir,
      { kind: TRIGGER_DECISION_KIND, payload: { decision: "skip", reason: "spawn-failed", note, trigger } },
      stamp,
    );
    return { decision: "skip", reason: "spawn-failed", note };
  }
  const pid = child.pid;
  appendArchiveRecord(
    options.homeDir,
    { kind: TRIGGER_DECISION_KIND, payload: { decision: "launch", note: gate.note, pid, trigger } },
    stamp,
  );
  return { decision: "launch", note: gate.note, pid };
}

/** 会话结束入口(11.5):阈值/冷却/预算判断 + 一次性 detached 作业拉起。 */
export function maybeLaunchOnSessionEnd(options: TryLaunchJobOptions): TriggerDecision | null {
  return tryLaunchJob(options);
}

/**
 * 会话启动入口(11.6 补偿评估):SIGKILL/崩溃不发结束事件,启动路径对
 * 上次遗漏的触发做同一套判定。与结束路径唯一的行为差异是调用时点——
 * 累计信号以上次作业结束为界,不会把已消费的信号再触发一遍。
 */
export function maybeLaunchOnSessionStart(options: TryLaunchJobOptions): TriggerDecision | null {
  return tryLaunchJob(options);
}

/**
 * 作业收尾(释锁后)消费补跑标记并链起至多一次补跑(D3):有标记则清
 * 标记并按手动同款门拉起 `chain` 作业(豁免阈值/冷却——请求在置标记前
 * 已过这两道门;预算护栏照旧,skip 照记 trigger-decision);无标记返回
 * null 不链。崩溃语义:残留标记由下一次作业启动清掉(请求已被满足),
 * 丢失至多一次补跑请求(下次事件/手动自然补)。
 */
export function chainAfterJob(
  options: Pick<TryLaunchJobOptions, "homeDir" | "limits" | "now" | "jobCommand" | "spawnFn">,
): TriggerDecision | null {
  const request = consumeRunRequest(options.homeDir);
  if (request === null) return null;
  return tryLaunchJob({
    homeDir: options.homeDir,
    bypass: { threshold: true, cooldown: true },
    trigger: "chain",
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.jobCommand !== undefined ? { jobCommand: options.jobCommand } : {}),
    ...(options.spawnFn !== undefined ? { spawnFn: options.spawnFn } : {}),
  });
}

/** 默认作业命令:本包 jobMain 入口(dist 的 .js;经 tsx 直跑源码时同后缀
 * 取 .ts,与 extension 的 load 说明符同款解析);argv 尾部由拉起方补 homeDir。 */
function defaultJobCommand(): { bin: string; args: readonly string[] } {
  const self = import.meta.url;
  return {
    bin: process.execPath,
    args: [fileURLToPath(new URL(self.endsWith(".ts") ? "./jobMain.ts" : "./jobMain.js", self))],
  };
}
