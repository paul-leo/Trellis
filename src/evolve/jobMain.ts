/**
 * 一次性 detached 作业入口(trellis-evolve 任务 11.5)。
 *
 * 契约:argv = [--hold-ms N] [--trigger event|manual|chain] <homeDir>。
 * `--hold-ms`(持有锁 N 毫秒后再收尾,供集成测试观察"作业运行中"的锁
 * 状态;生产不传,作业即时完成)。`--trigger` 记录触发来源入 job-run
 * 档案(缺省 event;chain 为补跑链起,run-backfill D3)。锁由作业自身
 * 持有(拉起方 spawn 前只做活锁检查,本入口再权威抢一次以防并发双拉起
 * 竞态,抢不到立即退出、不做任何工作、不排队)。壳语义(抢锁/释放、
 * job-run 落档含 trigger 字段、错误收口)在 `jobShell.js`——`trellis
 * evolve run` 前台手动触发走同一壳(D1 不另写执行路径)。作业体是
 * rule-based 治理流水的一次运行:`runEvolveJob`(信号 → rule-based
 * 提案 → 机械校验 → L1 前闸 → 风险/采纳门 → 应用 → lesson,14.1 的
 * fixture E2E 同链)。引擎内核(packages/evolve-engine 的
 * schedule/recursion/proposer/selection/judge)golden 锚定但生产未经
 * 此消费,待 L2/探针任务集接入。级别 off/observe 时作业体零副作用早退。
 *
 * 注意:本文件是入口脚本,被 import 时顶层即执行;测试只应 spawn 它,
 * 不应 import(需要锁原语请从 `trigger.js` 取,作业壳从 `jobShell.js`
 * 取,作业体从 `jobRun.js` 取)。
 */

import { runJobShell, type JobTriggerKind } from "./jobShell.js";

const TRIGGER_KINDS: readonly string[] = ["event", "manual", "chain"];

const argv = process.argv.slice(2);
let holdMs = 0;
const holdIdx = argv.indexOf("--hold-ms");
if (holdIdx !== -1) {
  holdMs = Number(argv[holdIdx + 1] ?? 0);
  argv.splice(holdIdx, 2);
}
let trigger: JobTriggerKind = "event";
const triggerIdx = argv.indexOf("--trigger");
if (triggerIdx !== -1) {
  const raw = argv[triggerIdx + 1];
  if (raw === undefined || !TRIGGER_KINDS.includes(raw)) {
    console.error(`jobMain: --trigger 必须是 ${TRIGGER_KINDS.join(" | ")}`);
    process.exit(2);
  }
  trigger = raw as JobTriggerKind;
  argv.splice(triggerIdx, 2);
}
const homeDir = argv[argv.length - 1];
if (homeDir === undefined || homeDir === "") {
  console.error("jobMain: 用法 node jobMain.js [--hold-ms N] [--trigger event|manual|chain] <homeDir>");
  process.exit(2);
}

const result = await runJobShell(homeDir, { trigger, holdMs });
if (result.status === "error") {
  console.error(`jobMain: 作业体失败:${result.message}`);
  process.exitCode = 1;
}
// lock-busy:静默退出 0(竞态窗口已有作业在跑,不排队)。
