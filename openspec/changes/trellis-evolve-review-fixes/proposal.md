# Proposal

## Why

六问 review 逐文件核对出闭环与可信度的五处漂移:①**批准→应用无路径**——`approve` 只翻状态,应用只发生在下一次触发的作业里,而触发要 ≥10 新信号 + 6h 冷却,批准的编辑可能滞留大半天才生效(闭环最后一公里断裂,真机最大空转点);②应用算出的逐 agent 生效时点(effects)**计算后丢弃**,不入档案、报告不可回放(spec"采纳的生效边界"要求向用户说明,实现没做到位);③自动采纳通知的回滚指引是泛化命令形态(`trellis rollback --list`),**不含真实备份会话标识**;④recorder 在工具调用热路径同步 `appendFileSync` 落盘,与"订阅者异步落盘"的设计意图(D3)不一致;⑤文档/头注释声称"作业体即移植引擎的一次运行",与实际不符——作业体是 rule-based 治理流水,引擎的 schedule/recursion/proposer/selection/judge 生产零触达,是 golden 锚定的待用内核。①②③伤闭环,④伤热路径延迟,⑤误导接手者。

## What Changes

- **批准即应用**:`approve` 成功后在同一命令内经托管备份会话应用全部已批准未应用的编辑(幂等;运行档案记备份会话标识);应用失败/部分失败时提案保持 `approved`,可重试。新增显式应用入口 `trellis evolve apply`(幂等:只应用已批准未应用的,无事可做零副作用),兼作失败重试与滞留消化入口。CLI 应用路径持既有单飞作业锁,防与运行中作业并发双写。
- **生效时点入档**:apply-run 档案记录逐 agent 生效说明(effects)与同步退出码;作业摘要携带 effects(job-run 档案随之入档);`report` 时间线回放生效说明。
- **回滚指引真实化**:自动采纳通知在应用后重写回滚行为真实的 `trellis evolve rollback <runId>`;approve/apply 输出同样指明真实备份会话标识,不再只有泛化指引。
- **recorder 异步落盘**:信号写入移出事件处理热路径——进程内队列,事件循环内批量落盘;信号非审计级语义不变(坏行容错、丢当轮缓冲可接受),`flush()` 供测试与收尾。
- **文档/注释纠偏**:`docs/self-evolution.md`、`docs/roadmap.md`、`jobMain.ts`/`jobRun.ts` 头注释如实描述作业体(rule-based 治理流水)与引擎内核状态(golden 锚定、生产未消费、随 L2/探针任务集接入)。

## Capabilities

### New Capabilities

(无)

### Modified Capabilities

- `self-evolution`:
  - 新增「批准即应用与显式应用入口」需求:批准即应用不滞留、失败保持 approved 可经显式 apply 幂等重试、回滚指引含真实备份会话标识。
  - 修改「采纳的生效边界」:生效时点说明 SHALL 同时写入运行档案,`report` 可回放。

## Impact

- 代码:`src/commands/evolve.ts`(approve 应用化、`apply` 子命令、USAGE)、`src/evolve/apply.ts`(apply-run 档案携 effects/syncExitCode)、`src/evolve/jobRun.ts`(摘要携 effects、通知回滚真实化)、`src/evolve/risk.ts`(通知回滚行重写助手)、`src/evolve/recorder.ts`(队列化批量落盘)、`src/evolve/reportView.ts`(effects 回放、approved 未应用计数)、`src/evolve/jobMain.ts`(头注释);`docs/self-evolution.md`、`docs/roadmap.md`。
- 测试:`test/unit/evolve/management.test.ts`(批准即应用、apply 幂等、失败重试、锁互斥)、`apply.test.ts`(档案 effects)、`jobRun.test.ts`(摘要 effects、通知真实回滚)、`recorder.test.ts`(异步落盘契约)、`reportView.test.ts`(回放与计数)。
- 协调:`trellis-evolve-run-backfill` 的「管理面命令不触发进化循环」delta 措辞加"批准/应用命令写入已批准编辑除外"从句(两变更并存下"其余管理面命令保持零副作用"需豁免该项)。
- 不动:引擎包、L1/风险分级与采纳门判定语义、备份回滚机制、GUI 结构(仅透传新字段)、auto-A 级别语义、run/import(属 run-backfill)。
