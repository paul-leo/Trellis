/**
 * 作业壳(trellis-evolve-run-backfill 任务 1.1)。
 *
 * jobMain(detached 入口)与 `trellis evolve run`(前台手动触发)共享的
 * 一次作业运行外壳:抢锁 → 跑作业体 → 落 job-run 档案 → 释锁,错误收口
 * (失败也落档案——不落档案会让水位线与冷却都不推进,同一确定性错误在
 * 每次会话结束被立即重拉成崩溃循环)。job-run payload 带 `trigger` 触发
 * 来源(`event` / `manual` / `chain`);旧档案无该字段时消费端视作 `event`。
 *
 * 本模块只做壳:作业体在 `jobRun.js`(rule-based 治理流水),锁与档案
 * 原语在 `trigger.js`。jobMain 仍是唯一 detached 入口(链起用),CLI
 * 前台调用本壳即手动触发(D1:不另写执行路径)。
 */

import { loadEvolveLevelPolicy } from "../host/index.js";
import { appendArchiveRecord } from "./archive.js";
import { runEvolveJob, type EvolveJobSummary } from "./jobRun.js";
import {
  acquireJobLock,
  chainAfterJob,
  consumeRunRequest,
  releaseJobLock,
  JOB_RUN_KIND,
  type JobTriggerKind,
  type TryLaunchJobOptions,
} from "./trigger.js";

/** 触发来源(单一来源在 trigger.js;此处 re-export 保持壳类型面完整)。 */
export type { JobTriggerKind } from "./trigger.js";

export interface RunJobShellOptions {
  /** 触发来源,入 job-run 档案。 */
  readonly trigger: JobTriggerKind;
  /** 持锁 N 毫秒后再跑作业体(jobMain `--hold-ms` 测试缝;生产不传)。 */
  readonly holdMs?: number;
  /** 时间源(毫秒);缺省 Date.now(测试注入固定时钟)。 */
  readonly now?: () => number;
  /** 补跑链起的作业命令/ spawn 注入缝(测试);缺省真实 jobMain 与 spawn。 */
  readonly chainJobCommand?: TryLaunchJobOptions["jobCommand"];
  readonly chainSpawnFn?: TryLaunchJobOptions["spawnFn"];
}

export type RunJobShellResult =
  /** 抢锁失败:已有作业在跑(竞态窗口),不做任何工作、不排队。 */
  | { readonly status: "lock-busy" }
  | { readonly status: "ok"; readonly summary: EvolveJobSummary }
  /** 作业体抛错:job-run 档案已落 error 记录(推进冷却)。 */
  | { readonly status: "error"; readonly message: string };

/**
 * 跑一次作业(壳语义):锁由本壳持有,收尾无论成败都释锁并落 job-run。
 * lock-busy 时不落任何档案(一次根本没发生的运行不在档案说谎)。
 */
export async function runJobShell(homeDir: string, options: RunJobShellOptions): Promise<RunJobShellResult> {
  const now = options.now ?? Date.now;
  const pid = process.pid;
  if (!acquireJobLock(homeDir, pid, now())) {
    return { status: "lock-busy" };
  }
  // 任何作业启动即清补跑标记(D3:该请求已被本次运行满足)。
  consumeRunRequest(homeDir);
  const startedAtMs = now();
  try {
    if (options.holdMs !== undefined && options.holdMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.holdMs));
    }
    const summary = await runEvolveJob(homeDir, { now });
    appendArchiveRecord(homeDir, {
      kind: JOB_RUN_KIND,
      payload: {
        pid,
        startedAtMs,
        endedAtMs: now(),
        trigger: options.trigger,
        signalsMergedAtMs: summary.signalsMergedAtMs,
        summary,
      },
    });
    return { status: "ok", summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      appendArchiveRecord(homeDir, {
        kind: JOB_RUN_KIND,
        payload: { pid, startedAtMs, endedAtMs: now(), trigger: options.trigger, error: message },
      });
    } catch {
      // 档案写入自身失败(如磁盘满)时不再连锁,锁仍由 finally 释放。
    }
    return { status: "error", message };
  } finally {
    releaseJobLock(homeDir, pid);
    // 收尾(释锁后)消费补跑标记并链起至多一次补跑(D3):运行期间到达的
    // 请求塌缩为一个标记,在这里被消费;无标记不链。
    const policy = loadEvolveLevelPolicy(homeDir);
    chainAfterJob({
      homeDir,
      now,
      ...(policy.trigger !== undefined ? { limits: policy.trigger } : {}),
      ...(options.chainJobCommand !== undefined ? { jobCommand: options.chainJobCommand } : {}),
      ...(options.chainSpawnFn !== undefined ? { spawnFn: options.chainSpawnFn } : {}),
    });
  }
}
