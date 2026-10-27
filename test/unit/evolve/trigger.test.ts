/**
 * 会话结束触发器测试(trellis-evolve 任务 11.5)。
 *
 * 对应 spec 场景:累计信号超阈值且不在冷却期 → 拉起一次性后台作业
 * (结束后无残留进程);作业运行中再次满足条件不启动第二个;超出每日
 * 提案上限时跳过并记录原因(不排队)。全部在 scratch HOME 上进行。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appendArchiveRecord, readArchiveRecords } from "../../../src/evolve/archive.js";
import { appendSignalLine, signalFilePath } from "../../../src/evolve/recorder.js";
import {
  acquireJobLock,
  chainAfterJob,
  consumeRunRequest,
  countPendingSignals,
  evaluateTrigger,
  isJobRunning,
  JOB_RUN_KIND,
  lastSignalWatermarkMs,
  maybeLaunchOnSessionEnd,
  maybeLaunchOnSessionStart,
  jobLockPath,
  releaseJobLock,
  resolveTriggerLimits,
  runRequestPath,
  setRunRequest,
  tryLaunchJob,
  TRIGGER_DECISION_KIND,
} from "../../../src/evolve/trigger.js";
import { runJobShell } from "../../../src/evolve/jobShell.js";
import type { TriggerState } from "../../../src/evolve/trigger.js";
import type { Signal } from "../../../src/evolve/types.js";
import { scratchHome } from "../../helpers/home.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function baseState(overrides: Partial<TriggerState> = {}): TriggerState {
  return {
    now: 1_000_000_000_000,
    pendingSignalCount: 10,
    lastJobEndedAt: null,
    jobRunning: false,
    todayProposalCount: 0,
    todayEditorCallCount: 0,
    ...overrides,
  };
}

function sessionStartSignal(collectedAt: number): Signal {
  return {
    kind: "session-start",
    source: "gateway-event",
    stableId: null,
    collectedAt,
    layer: { kind: "global" },
    ts: collectedAt,
    agent: "claude-code",
    session: `s-${collectedAt}`,
  };
}

function noSpawn() {
  const calls: string[][] = [];
  const spawnFn = (bin: string, args: readonly string[]) => {
    calls.push([bin, ...args]);
    return { pid: 4242, unref: () => {}, on: () => {} };
  };
  return { calls, spawnFn };
}

test("evaluateTrigger 判定矩阵:阈值、冷却、提案上限、editor 预算逐项跳过并给出原因", () => {
  const limits = resolveTriggerLimits({ signalThreshold: 5, cooldownMinutes: 60, dailyProposalCap: 2, editorBudget: 3 });

  assert.deepEqual(evaluateTrigger(baseState({ pendingSignalCount: 4 }), limits), {
    decision: "skip",
    reason: "below-threshold",
    note: "累计信号 4 未达阈值 5",
  });
  // 无信号永远不触发(即使阈值配 0)。
  assert.equal(
    evaluateTrigger(baseState({ pendingSignalCount: 0 }), resolveTriggerLimits({ signalThreshold: 0 })).decision,
    "skip",
  );
  assert.deepEqual(evaluateTrigger(baseState({ jobRunning: true }), limits).reason, "already-running");

  const inCooldown = evaluateTrigger(baseState({ lastJobEndedAt: 1_000_000_000_000 - 30 * 60_000 }), limits);
  assert.equal(inCooldown.decision, "skip");
  assert.equal(inCooldown.decision === "skip" && inCooldown.reason, "cooldown");

  // 冷却期外放行。
  assert.equal(
    evaluateTrigger(baseState({ lastJobEndedAt: 1_000_000_000_000 - 61 * 60_000 }), limits).decision,
    "launch",
  );

  const overCap = evaluateTrigger(baseState({ todayProposalCount: 2 }), limits);
  assert.deepEqual(overCap.decision === "skip" && overCap.reason, "daily-proposal-cap");

  const overBudget = evaluateTrigger(baseState({ todayEditorCallCount: 3 }), limits);
  assert.deepEqual(overBudget.decision === "skip" && overBudget.reason, "editor-budget");

  assert.equal(evaluateTrigger(baseState(), limits).decision, "launch");
});

test("超出每日提案上限时跳过并记录原因;不调用 spawn(不排队)", () => {
  const home = scratchHome("trigger-daily-cap");
  const nowMs = Date.parse("2026-10-25T12:00:00Z");
  const stamp = () => new Date(nowMs);
  for (let i = 0; i < 3; i++) {
    appendArchiveRecord(home, { kind: "proposal", payload: { i } }, stamp);
  }
  const { calls, spawnFn } = noSpawn();

  const result = tryLaunchJob({
    homeDir: home,
    limits: { dailyProposalCap: 3 },
    pendingSignalCount: 100,
    now: () => nowMs,
    spawnFn,
  });

  assert.deepEqual(result, {
    decision: "skip",
    reason: "daily-proposal-cap",
    note: "当日提案数 3 已达上限 3,跳过不排队",
  });
  assert.equal(calls.length, 0, "跳过时不 spawn 作业");

  // 原因已入档。
  const decisions = readArchiveRecords(home).filter((e) => e.kind === TRIGGER_DECISION_KIND);
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0]!.payload, {
    decision: "skip",
    reason: "daily-proposal-cap",
    note: "当日提案数 3 已达上限 3,跳过不排队",
    trigger: "event",
  });
});

test("单实例锁:活锁存在不启动第二个;死锁清除后可拉起", () => {
  const home = scratchHome("trigger-lock");

  // 活锁(本测试进程即"运行中的作业")。
  assert.equal(acquireJobLock(home, process.pid, Date.now()), true);
  assert.equal(isJobRunning(home), true);
  const running = noSpawn();
  const skipped = tryLaunchJob({ homeDir: home, pendingSignalCount: 100, spawnFn: running.spawnFn });
  assert.equal(skipped?.decision, "skip");
  assert.equal(skipped !== null && skipped.decision === "skip" ? skipped.reason : null, "already-running");
  assert.match(skipped?.note ?? "", /已有作业在运行,不启动第二个/);
  assert.match(skipped?.note ?? "", /已置补跑标记/, "运行中触发置补跑标记(D3)");
  assert.equal(running.calls.length, 0);
  // 标记已置:收尾链起的消费点(单槽)。
  assert.ok(consumeRunRequest(home) !== null);
  releaseJobLock(home, process.pid);
  assert.equal(existsSync(jobLockPath(home)), false);

  // 死锁(不存在的 pid):视为残留,清除后放行。
  writeFileSync(jobLockPath(home), JSON.stringify({ pid: 999_999_999, startedAtMs: 1 }), "utf-8");
  assert.equal(isJobRunning(home), false);
  assert.equal(existsSync(jobLockPath(home)), false, "死锁被清除");
  const afterStale = noSpawn();
  const launched = tryLaunchJob({ homeDir: home, pendingSignalCount: 100, spawnFn: afterStale.spawnFn });
  assert.equal(launched.decision, "launch");
  assert.equal(afterStale.calls.length, 1);
});

test("满足条件拉起一次 detached 作业:运行中不启第二个,结束后无残留进程", async () => {
  const home = scratchHome("trigger-launch");
  const jobMain = join(repoRoot, "src", "evolve", "jobMain.ts");
  // --hold-ms:让作业持有锁 1.5s,测试能观察到"运行中"状态(生产不传)。
  const jobCommand = { bin: process.execPath, args: ["--import", "tsx", jobMain, "--hold-ms", "1500"] };

  const first = maybeLaunchOnSessionEnd({ homeDir: home, pendingSignalCount: 100, jobCommand });
  assert.equal(first.decision, "launch");
  assert.ok(first.decision === "launch" && first.pid > 0);

  // 作业起跑后落锁:此刻再满足条件也不启第二个(already-running 置补跑标记)。
  await waitFor(() => isJobRunning(home));
  const second = noSpawn();
  const blocked = tryLaunchJob({ homeDir: home, pendingSignalCount: 100, jobCommand, spawnFn: second.spawnFn });
  assert.equal(blocked?.decision, "skip");
  assert.equal(blocked !== null && blocked.decision === "skip" ? blocked.reason : null, "already-running");
  assert.match(blocked?.note ?? "", /已置补跑标记/);
  assert.equal(second.calls.length, 0);
  // 消费掉补跑标记:本用例聚焦单实例语义,不让收尾链起再拉一个真实作业。
  assert.ok(consumeRunRequest(home) !== null);

  // 作业结束:锁清除、job-run 档案落盘、进程退出无残留。
  await waitFor(() => !isJobRunning(home) && readArchiveRecords(home).some((e) => e.kind === JOB_RUN_KIND));
  const run = readArchiveRecords(home).find((e) => e.kind === JOB_RUN_KIND);
  const payload = run!.payload as { pid: number; startedAtMs: number; endedAtMs: number };
  assert.equal(payload.pid, first.pid);
  assert.ok(payload.endedAtMs >= payload.startedAtMs);
  await waitFor(() => {
    try {
      process.kill(first.pid, 0);
      return false; // 仍存在(含僵尸)→ 继续等回收
    } catch {
      return true; // ESRCH:无残留
    }
  });
});

test("countPendingSignals:只计上次作业结束以来的信号", () => {
  const home = scratchHome("trigger-count");
  const path = signalFilePath(home, 1);
  mkdirSync(join(home, ".trellis", "evolve", "signals"), { recursive: true });
  appendSignalLine(path, sessionStartSignal(100));
  appendSignalLine(path, sessionStartSignal(200));
  appendSignalLine(path, sessionStartSignal(300));

  assert.equal(countPendingSignals(home, null), 3);
  assert.equal(countPendingSignals(home, 150), 2);
  assert.equal(countPendingSignals(home, 300), 0);
  // 无信号目录时为 0(读取不建目录)。
  assert.equal(countPendingSignals(scratchHome("trigger-count-empty"), null), 0);
});

test("tryLaunchJob 缺省 pendingSignalCount 时自动统计;launch 判定入档含 pid", async () => {
  const home = scratchHome("trigger-auto-count");
  // 一条信号、阈值 1 → 无历史作业 → 应拉起(stub spawn)。
  appendSignalLine(signalFilePath(home, 2), sessionStartSignal(500));
  const { calls, spawnFn } = noSpawn();
  const result = tryLaunchJob({
    homeDir: home,
    limits: { signalThreshold: 1 },
    now: () => 1_000,
    spawnFn,
  });
  assert.equal(result.decision, "launch");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], process.execPath);
  assert.match(calls[0]![1]!, /jobMain\.(js|ts)$/, "缺省作业入口随运行形态解析(dist .js / tsx .ts)");
  assert.equal(calls[0]![calls[0]!.length - 1], home, "argv 尾部是 homeDir");

  const decisions = readArchiveRecords(home).filter((e) => e.kind === TRIGGER_DECISION_KIND);
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0]!.payload, {
    decision: "launch",
    note: "累计信号 1 达阈值 1,不在冷却期且预算未超限",
    pid: 4242,
    trigger: "event",
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: 超时");
    await delay(25);
  }
}

// ---------- 11.6 补偿评估 ----------

test("补偿评估:上一会话被强杀(无结束事件)后,下次启动仍按累计信号与阈值决定", () => {
  // 强杀模拟:会话写入信号后进程消失——无结束事件、无触发判定、无作业。
  const home = scratchHome("trigger-compensate");
  const path = signalFilePath(home, 7);
  appendSignalLine(path, sessionStartSignal(100));
  appendSignalLine(path, sessionStartSignal(200));
  assert.equal(readArchiveRecords(home).length, 0, "强杀后无任何触发/作业记录");

  // 启动路径:低于阈值 → 跳过(仍做了评估,原因入档)。
  const lowCalls = noSpawn();
  const low = maybeLaunchOnSessionStart({
    homeDir: home,
    limits: { signalThreshold: 3 },
    now: () => 1_000,
    spawnFn: lowCalls.spawnFn,
  });
  assert.ok(low && low.decision === "skip" && low.reason === "below-threshold");
  assert.equal(lowCalls.calls.length, 0);

  // 同一批累计信号,阈值达到 → 启动路径照常拉起(补偿生效)。
  const goCalls = noSpawn();
  const go = maybeLaunchOnSessionStart({
    homeDir: home,
    limits: { signalThreshold: 2 },
    now: () => 2_000,
    spawnFn: goCalls.spawnFn,
  });
  assert.ok(go && go.decision === "launch");
  assert.equal(goCalls.calls.length, 1);
});

test("补偿不重复消费:作业结束后,启动评估只计作业之后的新信号", () => {
  const home = scratchHome("trigger-consume");
  const path = signalFilePath(home, 8);
  appendSignalLine(path, sessionStartSignal(100));
  appendSignalLine(path, sessionStartSignal(200));
  // 模拟作业已跑完并消费了这两条(endedAtMs 在其后)。
  appendArchiveRecord(
    home,
    { kind: JOB_RUN_KIND, payload: { pid: 1, startedAtMs: 50, endedAtMs: 250 } },
    () => new Date(250),
  );

  const { calls, spawnFn } = noSpawn();
  const result = maybeLaunchOnSessionStart({
    homeDir: home,
    limits: { signalThreshold: 1 },
    now: () => 300,
    spawnFn,
  });
  assert.ok(result && result.decision === "skip" && result.reason === "below-threshold");
  assert.equal(calls.length, 0);

  // 作业之后的新信号重新累计,达到阈值即可再触发(冷却期置 0 聚焦消费边界)。
  appendSignalLine(path, sessionStartSignal(400));
  const again = maybeLaunchOnSessionStart({
    homeDir: home,
    limits: { signalThreshold: 1, cooldownMinutes: 0 },
    now: () => 500,
    spawnFn,
  });
  assert.ok(again && again.decision === "launch");
});

test("off 零副作用:enabled 为 false 时不判定、不入档、不拉起", () => {
  const home = scratchHome("trigger-off");
  const { calls, spawnFn } = noSpawn();
  const result = tryLaunchJob({
    homeDir: home,
    enabled: () => false,
    pendingSignalCount: 100,
    spawnFn,
  });
  assert.equal(result, null);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(join(home, ".trellis")), false, "off 时连状态目录都不建");
});

// ---------- 拉起失败与失败作业(审查修复轮) ----------

test("spawn 失败:不记假 launch,档案记 spawn-failed,error 事件被收容", () => {
  const home = scratchHome("trigger-spawn-fail");
  const listeners = new Map<string, () => void>();
  const spawnFn = () => ({
    pid: undefined,
    unref: () => {},
    on: (event: string, listener: () => void) => {
      listeners.set(event, listener);
    },
  });
  const result = tryLaunchJob({ homeDir: home, pendingSignalCount: 100, spawnFn });
  assert.deepEqual(result, {
    decision: "skip",
    reason: "spawn-failed",
    note: `作业进程拉起失败(${process.execPath} 未获得 pid),本次不排队`,
  });
  const decisions = readArchiveRecords(home).filter((e) => e.kind === TRIGGER_DECISION_KIND);
  assert.equal(decisions.length, 1);
  assert.equal((decisions[0]!.payload as { decision: string }).decision, "skip");
  // error 监听已挂:异步 error 事件不会变成 uncaughtException 打垮宿主。
  assert.ok(listeners.has("error"), "spawn error 事件必须有收容监听");
  listeners.get("error")!();
});

test("信号水位线:优先 signalsMergedAtMs,作业运行期间到达的信号不丢", () => {
  const home = scratchHome("trigger-watermark");
  // 上一作业:T=100 合并信号,T=200 结束。
  appendArchiveRecord(
    home,
    { kind: JOB_RUN_KIND, payload: { pid: 1, startedAtMs: 90, endedAtMs: 200, signalsMergedAtMs: 100 } },
    () => new Date(200),
  );
  // 作业运行期间(collectedAt ∈ (100, 200])到达的信号。
  appendSignalLine(signalFilePath(home, 1), sessionStartSignal(150));
  // 作业结束后的信号。
  appendSignalLine(signalFilePath(home, 1), sessionStartSignal(300));

  // 水位线是合并时刻 100:两条都未消费。若误用 endedAtMs=200,collectedAt=150 的信号会永久丢失。
  assert.equal(countPendingSignals(home, lastSignalWatermarkMs(readArchiveRecords(home))), 2);
  // 旧档案无 signalsMergedAtMs 字段时回退 endedAtMs。
  const legacy = [
    { kind: JOB_RUN_KIND, recordedAt: new Date(200).toISOString(), payload: { pid: 1, startedAtMs: 90, endedAtMs: 200 } },
  ];
  assert.equal(lastSignalWatermarkMs(legacy), 200);
});

test("作业体抛错:job-run 档案落 error 记录(推进冷却),锁释放,退出码非零", async () => {
  const home = scratchHome("jobmain-failure");
  // 损坏的 evolve.yaml 让 runEvolveJob 的级别闸硬抛(present-but-invalid)。
  mkdirSync(join(home, ".trellis"), { recursive: true });
  writeFileSync(join(home, ".trellis", "evolve.yaml"), "default_level: superuser\n", "utf-8");
  const jobMain = join(repoRoot, "src", "evolve", "jobMain.ts");

  const child = spawn(process.execPath, ["--import", "tsx", jobMain, home], { stdio: "ignore" });
  const exitCode = await new Promise((resolve) => child.on("exit", resolve));

  assert.equal(exitCode, 1);
  const runs = readArchiveRecords(home).filter((e) => e.kind === JOB_RUN_KIND);
  assert.equal(runs.length, 1, "失败也必须落 job-run 档案(否则水位线/冷却不推进 → 崩溃循环)");
  const payload = runs[0]!.payload as { error?: string; endedAtMs?: number };
  assert.match(payload.error ?? "", /evolve\.yaml/);
  assert.equal(typeof payload.endedAtMs, "number");
  assert.equal(existsSync(jobLockPath(home)), false, "锁已释放");
});

// ---------- run-backfill:门豁免 / 补跑标记 / 链起 ----------

test("evaluateTrigger bypass 组合矩阵:阈值/冷却可豁免,预算与单实例不豁免", () => {
  const limits = resolveTriggerLimits(undefined);
  const skipReason = (d: ReturnType<typeof evaluateTrigger>): string | null =>
    d.decision === "skip" ? d.reason : null;

  // 缺省不豁免:事件路径语义逐字不变。
  assert.deepEqual(evaluateTrigger(baseState({ pendingSignalCount: 1 }), limits), {
    decision: "skip",
    reason: "below-threshold",
    note: "累计信号 1 未达阈值 10",
  });

  // 只豁免阈值:冷却仍拦。
  const inCooldown = baseState({ pendingSignalCount: 1, lastJobEndedAt: baseState().now - 60_000 });
  assert.equal(skipReason(evaluateTrigger(inCooldown, limits, { threshold: true })), "cooldown");

  // 只豁免冷却:阈值仍拦。
  assert.equal(skipReason(evaluateTrigger(baseState({ pendingSignalCount: 1 }), limits, { cooldown: true })), "below-threshold");

  // 双豁免:0 信号也 launch,note 记豁免(D2 手动语义)。
  const waived = evaluateTrigger(
    baseState({ pendingSignalCount: 0, lastJobEndedAt: baseState().now - 1 }),
    limits,
    { threshold: true, cooldown: true },
  );
  assert.equal(waived.decision, "launch");
  assert.match(waived.note, /阈值与冷却判断已豁免/);

  // 预算不豁免:双豁免下仍按上限跳过。
  assert.equal(
    skipReason(evaluateTrigger(baseState({ pendingSignalCount: 0, todayProposalCount: 3 }), limits, { threshold: true, cooldown: true })),
    "daily-proposal-cap",
  );
  assert.equal(
    skipReason(evaluateTrigger(baseState({ pendingSignalCount: 0, todayEditorCallCount: 5 }), limits, { threshold: true, cooldown: true })),
    "editor-budget",
  );

  // 单实例不豁免。
  assert.equal(
    skipReason(evaluateTrigger(baseState({ jobRunning: true }), limits, { threshold: true, cooldown: true })),
    "already-running",
  );
});

test("补跑标记:多次请求塌缩为一个(count 仅审计),CAS 消费读后删", () => {
  const home = scratchHome("trigger-run-request");
  assert.equal(consumeRunRequest(home), null, "无标记消费为 null");

  setRunRequest(home, "trigger:manual", 100);
  const collapsed = setRunRequest(home, "trigger:event", 200);
  assert.equal(collapsed.reason, "trigger:manual", "首次置位保持(塌缩)");
  assert.equal(collapsed.setAtMs, 100);
  assert.equal(collapsed.count, 2, "count 仅审计");

  const consumed = consumeRunRequest(home);
  assert.deepEqual(consumed, { reason: "trigger:manual", setAtMs: 100, count: 2 });
  assert.equal(existsSync(runRequestPath(home)), false, "消费 = CAS 读后删");
  assert.equal(consumeRunRequest(home), null);
});

test("收尾链起:有标记链起至多一跳(--trigger chain);无标记不链", () => {
  const home = scratchHome("trigger-chain");
  const none = noSpawn();
  assert.equal(chainAfterJob({ homeDir: home, spawnFn: none.spawnFn }), null, "无标记不链");
  assert.equal(none.calls.length, 0);

  setRunRequest(home, "trigger:manual", 100);
  const chained = noSpawn();
  const decision = chainAfterJob({ homeDir: home, spawnFn: chained.spawnFn, now: () => 200 });
  assert.equal(decision?.decision, "launch");
  assert.equal(chained.calls.length, 1, "链起一跳");
  const args = chained.calls[0]!;
  assert.equal(args[args.indexOf("--trigger") + 1], "chain", "链起作业记 trigger=chain");
  assert.equal(args[args.length - 1], home);

  // 标记已消费:再收尾不链(至多一次)。
  const again = noSpawn();
  assert.equal(chainAfterJob({ homeDir: home, spawnFn: again.spawnFn }), null);
  assert.equal(again.calls.length, 0);
});

test("链起同受预算护栏:超限 skip 记因(trigger=chain),不 spawn", () => {
  const home = scratchHome("trigger-chain-budget");
  const nowMs = Date.parse("2026-10-25T12:00:00Z");
  for (let i = 0; i < 3; i++) {
    appendArchiveRecord(home, { kind: "proposal", payload: { i } }, () => new Date(nowMs));
  }
  setRunRequest(home, "trigger:manual", nowMs);
  const { calls, spawnFn } = noSpawn();
  const decision = chainAfterJob({ homeDir: home, spawnFn, now: () => nowMs });
  assert.equal(decision?.decision, "skip");
  assert.equal(calls.length, 0, "预算超限不 spawn");
  const decisions = readArchiveRecords(home).filter((e) => e.kind === TRIGGER_DECISION_KIND);
  assert.equal(decisions.length, 1);
  const payload = decisions[0]!.payload as { reason?: string; trigger?: string };
  assert.equal(payload.reason, "daily-proposal-cap");
  assert.equal(payload.trigger, "chain", "判定档案记补跑来源");
});

test("runJobShell:job-run 带 trigger 字段;运行中置位的标记收尾释锁后链起一跳", async () => {
  const home = scratchHome("trigger-shell-chain");
  const chain = noSpawn();
  const shell = runJobShell(home, { trigger: "manual", holdMs: 150, chainSpawnFn: chain.spawnFn });
  await delay(30);
  setRunRequest(home, "trigger:event", Date.now());
  const result = await shell;
  assert.equal(result.status, "ok");
  assert.equal(chain.calls.length, 1, "收尾(释锁后)链起至多一跳");
  assert.equal(chain.calls[0]![chain.calls[0]!.indexOf("--trigger") + 1], "chain");

  const runs = readArchiveRecords(home).filter((e) => e.kind === JOB_RUN_KIND);
  assert.equal(runs.length, 1);
  assert.equal((runs[0]!.payload as { trigger?: string }).trigger, "manual", "job-run 档案记触发来源");
});

test("崩溃语义:残留标记由下一次作业启动清掉(请求已被满足);丢失至多一次请求", async () => {
  const home = scratchHome("trigger-chain-crash");
  // 残留(作业"崩溃"前请求已置位):下一次作业启动即清,不产生多余补跑。
  setRunRequest(home, "trigger:manual", 100);
  const chain = noSpawn();
  const result = await runJobShell(home, { trigger: "event", chainSpawnFn: chain.spawnFn });
  assert.equal(result.status, "ok");
  assert.equal(existsSync(runRequestPath(home)), false, "作业启动清标记");
  assert.equal(chain.calls.length, 0, "启动时被清的请求不进入收尾链起");
  // 丢失(标记文件不在):消费为 null,下次事件/手动自然补(设计接受)。
  assert.equal(consumeRunRequest(home), null);
});
