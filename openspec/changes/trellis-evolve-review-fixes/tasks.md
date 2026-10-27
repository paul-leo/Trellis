# Tasks

## 1. 批准即应用(❌2)

- [x] 1.1 `src/evolve/apply.ts`:apply-run 档案 payload 增 `effects` 与 `syncExitCode`(成功条目;失败条目保持 failed 语义);验证 `test/unit/evolve/apply.test.ts` 新断言通过
- [x] 1.2 `src/evolve/risk.ts`:新增 `retargetNotificationRollback` 纯函数(只重写通知"回滚:"行);验证 `test/unit/evolve/risk.test.ts` 新断言通过
- [x] 1.3 `src/commands/evolve.ts`:approve 成功后内联应用(持单飞锁;锁忙暂缓并告知),输出应用结果、effects、真实回滚命令;新增 `apply` 子命令(幂等,无事可做零副作用);USAGE 与头注释同步"批准即应用";验证 `test/unit/evolve/management.test.ts` 新增用例(批准即应用/失败保持 approved 可重试/显式应用幂等/锁忙暂缓)通过
- [x] 1.4 `src/evolve/jobRun.ts`:`EvolveJobSummary.applied` 增 `effects`;应用后把自动采纳通知回滚行重写为真实 `trellis evolve rollback <runId>` 并入 notices;验证 `test/unit/evolve/jobRun.test.ts` 新断言通过

## 2. effects 入档与回放(❌3)

- [x] 2.1 `src/evolve/reportView.ts`:apply-run 分支回放 `effects`(旧档案无字段如实跳过);`counts` 增 `approvedUnapplied`;验证 `test/unit/evolve/reportView.test.ts` 新断言通过
- [x] 2.2 `src/commands/evolve.ts`:status/report 文本渲染透传 approved 未应用提示与 effects 时间线;验证 management/reportView 测试通过

## 3. recorder 异步落盘(❌4)

- [x] 3.1 `src/evolve/recorder.ts`:`handle` 入队 + setImmediate 合并批量落盘,新增 `flush()`;会话边界事件(session_start/session_end)同步收口——边界事件是触发判定的运行点,判定必须看得到含当前边界事件在内的全部信号(实现期细化);off/防自激/白名单/擦除语义不变;验证 `test/unit/evolve/recorder.test.ts` 按新契约(热路径先 flush 再读、边界同步)通过,新增"热路径不同步写盘、flush 后可见、边界同步落盘"用例

## 4. 文档/注释纠偏(❌1/❌5 措辞)

- [x] 4.1 `src/evolve/jobMain.ts`、`src/evolve/jobRun.ts` 头注释:"作业体即移植引擎的一次运行"改为 rule-based 治理流水 + 引擎内核待用的如实表述;验证 `npm run typecheck` 通过
- [x] 4.2 `docs/self-evolution.md`、`docs/roadmap.md`:生产接线/现状表述与实际一致(rule-based 流水、引擎生产未消费、随 L2 接入);验证人工 diff 审读 + 全文检索无残留旧措辞

## 5. 协调与整体验证

- [x] 5.1 `openspec/changes/trellis-evolve-run-backfill/specs/self-evolution/spec.md`:「管理面命令不触发进化循环」"其余管理面命令保持零副作用"加"批准/应用命令写入已批准编辑除外"从句;验证 `openspec validate --strict` 对两个 change 均通过
- [x] 5.2 全量回归:`npm test` 与 `npm run typecheck` 全绿(含 GUI sidecar 对报告增量字段的断言);验证测试输出 0 fail(1247 tests, 0 fail)
