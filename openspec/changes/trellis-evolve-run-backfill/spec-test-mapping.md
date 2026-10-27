# Spec 场景 → 测试映射表(trellis-evolve-run-backfill,4.3)

> 用途:tasks 4.3 的验收素材——"每条 spec 场景至少映射到一个测试";创建
> PR 时整表并入 PR 描述。测试名取自 `node:test` 的 `test(...)`/`it(...)`
> 标题,文件路径相对仓库根。验证基线(2026-10-27):宿主 `npm test`
> **1265/1265**、`tsc --noEmit` 干净;GUI `test:smoke` **10/10**(含
> job-run trigger 透传断言)、`sidecar:typecheck` 干净;`openspec validate
> --strict` 通过。引擎不涉。

## 历史数据导入与幂等回填(ADDED,6 场景)

| # | 场景 | 测试 |
|---|---|---|
| 1 | 元数据白名单 | `test/unit/evolve/importHistory.test.ts` "场景:元数据白名单——载荷/正文不入库,只留白名单字段;坏行跳过计数" |
| 2 | 凭据擦除 | `test/unit/evolve/importHistory.test.ts` "场景:凭据擦除——字符串字段过 eraseSecrets,凭据形态不落盘" |
| 3 | 重复导入为空操作 | `test/unit/evolve/importHistory.test.ts` "场景:重复导入为空操作——台账幂等,不新增信号、不重复记账" |
| 4 | 导入不触发作业 | `test/unit/evolve/importHistory.test.ts` "场景:导入不触发作业——无 job-run/trigger-decision,信号静止待消费" |
| 5 | 重复消费不产生重复提案 | `test/unit/evolve/importHistory.test.ts` "场景:重复消费不产生重复提案——导入信号进发现面,提案 id 确定性" |
| 6 | 不可解析源失败收口 | `test/unit/evolve/importHistory.test.ts` "场景:不可解析源失败收口——非零退出、零写入;整批任一失败全批零写入"+ "CLI:import 分发" |

## 触发是事件驱动的一次性作业(MODIFIED,新增 4 场景 + 门语义)

| # | 场景 | 测试 |
|---|---|---|
| 7 | 手动触发即刻运行 | `test/unit/evolve/management.test.ts` "场景:手动触发即刻运行——run 跳过阈值/冷却,job-run 档案记 trigger=manual" |
| 8 | 手动触发遵守预算护栏 | `test/unit/evolve/management.test.ts` "场景:手动触发遵守预算护栏——超限跳过并记因(trigger=manual),不排队" |
| 9 | 运行中请求合并 | `test/unit/evolve/trigger.test.ts` "补跑标记:多次请求塌缩为一个(count 仅审计),CAS 消费读后删"+ `test/unit/evolve/management.test.ts` "手动触发遇运行中作业:already-running 记因并置补跑标记(单槽)" |
| 10 | 补跑至多一次 | `test/unit/evolve/trigger.test.ts` "收尾链起:有标记链起至多一跳(--trigger chain);无标记不链" + "runJobShell:job-run 带 trigger 字段;运行中置位的标记收尾释锁后链起一跳" + "崩溃语义:残留标记由下一次作业启动清掉;丢失至多一次请求" |
| — | 门豁免语义(阈值/冷却豁免、预算与单实例不豁免) | `test/unit/evolve/trigger.test.ts` "evaluateTrigger bypass 组合矩阵:阈值/冷却可豁免,预算与单实例不豁免" + "链起同受预算护栏:超限 skip 记因(trigger=chain),不 spawn" |
| — | 事件路径语义逐字不变 | `test/unit/evolve/trigger.test.ts`(既有判定矩阵/补偿评估组回归)+ `test/unit/evolve/extension.test.ts` "propose:recorder + 触发器"(补跑标记波及的期望更新后仍绿) |

## 管理面命令不触发进化循环(MODIFIED,新增 3 场景)

| # | 场景 | 测试 |
|---|---|---|
| 11 | 手动触发是唯一命令行入口 | `test/unit/evolve/management.test.ts` "命令不触发循环:enable/status 后信号目录与档案零新增"(其余命令)+ "场景:手动触发即刻运行"(只有 run 执行作业体) |
| 12 | dry-run 不产生写入 | `test/unit/evolve/management.test.ts` "场景:dry-run 不产生写入——预览信号数与护栏判定,状态逐字节不变" |
| 13 | observe 级别零副作用早退 | `test/unit/evolve/management.test.ts` "场景:observe 级别零副作用早退——run 说明当前级别与调整方法,不产生写入" |
