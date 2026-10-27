/**
 * 一次性 detached 作业入口(trellis-evolve 任务 11.5)。
 *
 * 契约:argv = [...flags] <homeDir>,flag 目前只有 `--hold-ms N`(持有锁
 * N 毫秒后再收尾,供集成测试观察"作业运行中"的锁状态;生产不传,作业
 * 即时完成)。锁由作业自身持有(拉起方 spawn 前只做活锁检查,本入口再
 * 权威抢一次以防并发双拉起竞态,抢不到立即退出、不做任何工作、不排队)。
 * 作业体是 rule-based 治理流水的一次运行:`runEvolveJob`(信号 →
 * rule-based 提案 → 机械校验 → L1 前闸 → 风险/采纳门 → 应用 → lesson,
 * 14.1 的 fixture E2E 同链)。引擎内核(packages/evolve-engine 的
 * schedule/recursion/proposer/selection/judge)golden 锚定但生产未经
 * 此消费,待 L2/探针任务集接入。级别 off/observe 时作业体零副作用早退。
 *
 * 注意:本文件是入口脚本,被 import 时顶层即执行;测试只应 spawn 它,
 * 不应 import(需要锁原语请从 `trigger.js` 取,作业体从 `jobRun.js` 取)。
 */

import { appendArchiveRecord } from "./archive.js";
import { runEvolveJob } from "./jobRun.js";
import { acquireJobLock, releaseJobLock, JOB_RUN_KIND } from "./trigger.js";

const argv = process.argv.slice(2);
let holdMs = 0;
const holdIdx = argv.indexOf("--hold-ms");
if (holdIdx !== -1) {
  holdMs = Number(argv[holdIdx + 1] ?? 0);
  argv.splice(holdIdx, 2);
}
const homeDir = argv[argv.length - 1];
if (homeDir === undefined || homeDir === "") {
  console.error("jobMain: 用法 node jobMain.js [--hold-ms N] <homeDir>");
  process.exit(2);
}

const pid = process.pid;
if (!acquireJobLock(homeDir, pid, Date.now())) {
  // 已有作业在跑(竞态窗口):静默退出,不排队。
  process.exit(0);
}

const startedAtMs = Date.now();
try {
  // 作业体:治理流水的一次运行(12.x;14.1 同链;引擎内核待 L2 接入)。
  if (holdMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  }
  const summary = await runEvolveJob(homeDir);
  const endedAtMs = Date.now();
  appendArchiveRecord(homeDir, {
    kind: JOB_RUN_KIND,
    payload: { pid, startedAtMs, endedAtMs, signalsMergedAtMs: summary.signalsMergedAtMs, summary },
  });
} catch (err) {
  // 失败也必须落 job-run:不写档案 → 水位线与冷却都不推进 → 同一确定性
  // 错误(如损坏的 evolve.yaml)会在每次会话结束被立即重拉(崩溃循环)。
  // endedAtMs 推进冷却、error 留审计;信号未合并则不带 signalsMergedAtMs。
  const message = err instanceof Error ? err.message : String(err);
  try {
    appendArchiveRecord(homeDir, {
      kind: JOB_RUN_KIND,
      payload: { pid, startedAtMs, endedAtMs: Date.now(), error: message },
    });
  } catch {
    // 档案写入自身失败(如磁盘满)时不再连锁,锁仍由 finally 释放。
  }
  process.exitCode = 1;
} finally {
  releaseJobLock(homeDir, pid);
}
