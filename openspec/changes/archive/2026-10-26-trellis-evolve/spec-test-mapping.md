# Spec 场景 → 测试映射表(trellis-evolve,14.2)

> 用途:tasks 14.2 的验收素材——"每条 spec 场景至少映射到一个测试";创建 PR
> 时整表并入 PR 描述。测试名取自 `node:test` 的 `test(...)`/`it(...)` 标题,
> 文件路径相对仓库根。验证基线(2026-10-26,含生产接线收口后):宿主
> `npm test` **1216/1216**、`tsc --noEmit` 干净;引擎 `packages/evolve-engine`
> **175/175**、`check-deps` OK(runtime deps 为空)。生产接线收口另补
> `test/unit/evolve/extension.test.ts`(activate 级别→订阅者组合、清单装载
> 集成)、`test/unit/evolve/jobRun.test.ts`(作业体流水与 auto-A 分支)、
> `test/unit/evolve/enableManifest.test.ts`(enable/disable 清单生命周期),
> 并有 temp-HOME observe 接线冒烟(enable→gateway 会话信号/触发判定→
> disable→off 零记录)作真进程证据。

## self-evolution(41 场景)

| # | 场景 | 测试 |
|---|---|---|
| 1 | 默认关闭且零副作用 | `test/unit/hostLevels.test.ts`(三场景组) |
| 2 | 更具体的级别覆盖更宽泛的 | `test/unit/hostLevels.test.ts`(workspace 覆盖盖过全局默认) |
| 3 | 开启状态对 doctor 可见 | `test/unit/hostLevels.test.ts` |
| 4 | 依赖边界被测试强制 | `test/unit/evolveImportBoundary.test.ts`(越界 import 反例必红) |
| 5 | 载荷不入库 | `test/unit/evolve/recorder.test.ts` "载荷不入库:字段白名单 + secrets 擦除,任何凭据形态不落盘" |
| 6 | 进化自身活动不自激 | `test/unit/evolve/selfActivity.test.ts` "作业运行期间的调用/编辑不产生信号" |
| 7 | 用户纠正被主动上报 | `test/unit/evolve/report.test.ts` |
| 8 | 并发会话互不阻塞 | `test/unit/evolve/recorder.test.ts` "并发两会话互不阻塞且不丢信号;跨进程各自分文件" |
| 9 | 可选源缺席 | `test/unit/evolve/selfActivity.test.ts` "可选源缺席:无委托存储时返回 unavailable 且不抛" |
| 10 | 会话结束触发判断 | `test/unit/evolve/trigger.test.ts`(`maybeLaunchOnSessionEnd` 组) |
| 11 | 强杀后的补偿 | `test/unit/evolve/trigger.test.ts`(`maybeLaunchOnSessionStart` 组) |
| 12 | 单实例 | `test/unit/evolve/trigger.test.ts`(`acquireJobLock` / `isJobRunning`) |
| 13 | 超出预算时跳过 | `test/unit/evolve/trigger.test.ts`(每日提案上限跳过并记录原因) |
| 14 | 无证据提案被丢弃 | `test/unit/evolve/validate.test.ts`(`no-evidence` 组) |
| 15 | 校验失败带反馈重试一次 | `test/unit/evolve/validate.test.ts`(重试闭环:反馈接 `validate_tree`、至多一次) |
| 16 | 指向 auth 的编辑被拒绝 | `test/unit/evolve/validate.test.ts`(auth 块与 `mcp/servers.yaml` 两形态) |
| 17 | 指向进化自身配置的编辑被拒绝 | `test/unit/evolve/validate.test.ts`(`evolve.yaml` / `evolve/`) |
| 18 | workspace finding 产出 workspace 层提案 | `test/unit/evolve/fixtureE2e.test.ts`(提案层断言)+ `test/unit/evolve/validate.test.ts`(rule-based fallback) |
| 19 | 跨层编辑被拒绝 | `test/unit/evolve/validate.test.ts`(声明全局但目标在 `<repo>/.agents/`;workspace 越出 `layer.root`) |
| 20 | 不自动升格到全局 | `test/unit/evolve/validate.test.ts`(`needsExplicitApproval` 标记组) |
| 21 | workspace 编辑拒绝凭据字面值 | `test/unit/evolve/validate.test.ts`(凭据形态字面值拒、`${VAR}` 引用合法) |
| 22 | 命中的修复可采纳 | `test/unit/evolve/gate.test.ts` "场景 1:命中修复可采纳" |
| 23 | 引入回归则不可采纳 | `test/unit/evolve/gate.test.ts` "场景 2:引入回归不可采纳" |
| 24 | 被 workspace tombstone 的全局编辑不影响该 workspace | `test/unit/evolve/gate.test.ts` "场景 3:被 workspace tombstone 的全局编辑不影响该 workspace 的 verdict" |
| 25 | Class A 自动采纳并通知 | `test/unit/evolve/risk.test.ts` "场景1:auto-A + Class A + probe 通过 → 自动采纳并通知" |
| 26 | 低于 auto-A 时 Class A 也不自动采纳 | `test/unit/evolve/risk.test.ts` "场景2:propose 级别下 Class A 也不自动采纳" |
| 27 | 无法分类按 Class B | `test/unit/evolve/risk.test.ts` "场景3:无法分类(未知 kind)→ B" |
| 28 | 升格编辑按 Class B | `test/unit/evolve/risk.test.ts` "场景4:auto-A 下升格编辑仍按 B 呈现" |
| 29 | agent 接口没有批准能力 | `test/unit/evolve/pending.test.ts` "agent 接口没有批准能力(导出面无变更类操作)" |
| 30 | 非交互环境拒绝批准 | `test/unit/evolve/management.test.ts` "场景:非交互环境拒绝批准,提案保持 pending;--yes 不构成批准" |
| 31 | agent 能读到待批提案 | `test/unit/evolve/pending.test.ts` "场景:两条 pending → 两条摘要(证据 + 风险级别),不含凭据" |
| 32 | 多编辑运行整体回滚 | `test/unit/evolve/apply.test.ts` "三条编辑在同一备份会话内写入,标准回滚逐字节还原"+ `test/unit/host.test.ts` "多编辑在单备份会话内应用,rollbackSession 逐字节还原" |
| 33 | runtime agent 下个会话读到新版本 | `test/unit/evolve/apply.test.ts` "runtime 投递 agent 新会话读到新版本且无需同步" |
| 34 | 原生渲染 agent 触发同步 | `test/unit/evolve/apply.test.ts` "原生渲染 agent 触发同步并报告结果" |
| 35 | 切片变化使缓存失效 | `packages/evolve-engine/test/runmark.test.ts` "golden: fingerprint 与原版逐值一致"(base≠agg1/agg2 指纹即内容派生)+ "mark_complete → read_mark → is_complete 全生命周期" |
| 36 | 记忆未启用时 lesson 留在档案 | `test/unit/evolve/lesson.test.ts` "场景:记忆未启用 → lesson 连同证据留在档案,报 skipped 而非 failed" |
| 37 | 项目教训不外溢 | `test/unit/evolve/lesson.test.ts` "场景:仓库 X 的 workspace lesson 不原样进入 Y 的提案上下文" |
| 38 | probe 错误不等于批准 | `test/unit/evolve/risk.test.ts` "防御:probe 未通过时 Class A 不自动采纳"+ `test/unit/evolve/gate.test.ts` "场景 4:强制报错收口 —— 测量失败按'不采纳'收口" |
| 39 | 比较记录可序列化往返 | `test/unit/evolve/l2.test.ts` "场景:含匿名臂映射与失败收口 verdict 的记录往返后全部字段保留" |
| 40 | 启动规格不含绕过标志 | `test/unit/evolve/probeWorkspace.test.ts` "probe 启动规格拒绝审批/沙盒绕过标志" |
| 41 | 命令不启动循环 | `test/unit/evolve/management.test.ts` "命令不触发循环:enable/status 后信号目录零新增" |

## host-extension-points(17 场景)

| # | 场景 | 测试 |
|---|---|---|
| 1 | 上游与内建调用都产生事件 | `test/unit/hostEventBus.test.ts` "上游与内建调用都产生事件,元数据齐全且无载荷" |
| 2 | 事件不携带载荷 | `test/unit/hostEvents.test.ts` "toolCallEvent:事件对象只含白名单字段,无入参/结果载荷字段" +"事件序列化后不含构造现场入参的凭据形态字符串" |
| 3 | 订阅者抛异常不影响调用 | `test/unit/hostEventBus.test.ts` "订阅者抛异常/异步拒绝不影响调用结果,失败被吞并警告" |
| 4 | 无订阅者零变化 | `test/unit/hostEventBus.test.ts` "无订阅者时行为与引入前一致(含 observer 在位但无人订阅)" |
| 5 | 正常断开发出结束事件 | `test/unit/mcpGatewayShutdown.test.ts` "stdin EOF('end')在释放上游之前发'会话结束'" +"stdin 关闭('close')…"+"SIGTERM…" |
| 6 | 会话开始事件携带 workspace root | `test/unit/hostEventBus.test.ts` "会话标识在同一进程内一致;开始事件带 workspace root"+ `test/unit/hostEvents.test.ts` "sessionStartEvent / sessionEndEvent:白名单字段;workspace root 在开始事件上" |
| 7 | 强杀不保证结束事件 | `test/unit/mcpGatewayShutdown.test.ts` "SIGKILL 不保证结束事件:保证触发集合恰为 stdin end/close + SIGTERM/SIGINT/SIGHUP" |
| 8 | 注册失败不阻断启动 | `test/unit/hostExtensions.test.ts` "清单与条目的坏形态都被收口为失败而非崩溃"+"扩展加载失败被隔离…" |
| 9 | 门面不泄漏内部实现 | `test/unit/host.test.ts` "host 运行时导出恰为窄门面允许清单"+"src/host 不 re-export 任何 host 之外层的符号" |
| 10 | 编辑在备份会话内应用并可回滚 | `test/unit/host.test.ts` "多编辑在单备份会话内应用,rollbackSession 逐字节还原"+"批量编辑中途失败:会话仍 finalize 成可回滚记录" |
| 11 | staging 不触碰真实 canonical | `test/unit/host.test.ts` "staging 复制 + 候选编辑 + 检查后,真实 home 与 workspace 逐字节不变" |
| 12 | 两次检查可做集合差 | `test/unit/host.test.ts` "两次检查按稳定标识可集合差:修复 staging 恰好移除 workspace-toml-invalid" |
| 13 | 仅清单内扩展被装载 | `test/unit/hostExtensions.test.ts` "仅清单内扩展被装载:磁盘上的未声明模块不被 import" |
| 14 | 订阅者型扩展经同一契约装载 | `test/unit/hostExtensions.test.ts` "订阅者型扩展经同一契约装载:收到进程事件,工具列表不受影响" |
| 15 | 扩展加载失败被隔离 | `test/unit/hostExtensions.test.ts` "扩展加载失败被隔离:好扩展与核心 provider 照常工作,失败被报告" |
| 16 | 无扩展零变化 | `test/unit/hostExtensions.test.ts` "无扩展零变化:无清单时空载、零失败、零警告" |
| 17 | 移除消费者后托管测试照常通过 | `test/unit/hostingIndependence.test.ts`(把进化各部分移出构建 → 托管构建与测试不变) |

## 第 3–6 组 golden 对照集

对照集在 `packages/evolve-engine/golden/`(harness2 `demo.py` 确定性产物,归一化后逐字节锚;来源与复现方式见该目录 `README.md`)。TS 侧同输入比输出的 golden 锚定测试全部在引擎套件内,当前 **175/175 全绿**:

- tree(3.1):`tree.test.ts` harness 树编辑/序列化对照;
- runmark/ledger(3.1):`runmark.test.ts` fingerprint 逐值、`ledger.test.ts` 预算恒等式;
- judge(3.2):`judge.test.ts` None 语义(失败不入分母、永不记 0);
- spec/prompts(4.1):`spec.test.ts`/`prompts.test.ts` 提取正则与 Python 方言一致;
- context/library(4.2):`context.test.ts` 沙盒语义 + `library.test.ts` 回流产物;
- proposer(5.1):`proposer.test.ts` 缓存/退避/失败收口/审计;
- selection(5.2):`selection.test.ts` `assign_ids` golden 四例、`run_selection` 四配置 candidates/task.md/source 逐字节 + selection.json 逐字段键序、隔离绊线;
- schedule/recursion/report(6.1):`schedule.test.ts`/`recursion.test.ts`/`report.test.ts` 循环账本与 report 输出对照。

复核命令(cwd = `packages/evolve-engine`):

```bash
../../node_modules/.bin/tsc -p tsconfig.json \
  && ../../node_modules/.bin/tsx --test test/*.test.ts \
  && node scripts/check-deps.mjs
```

备注:`keepBaseInPool`(D11)、凭据 env(7.1)、无绕过标志(7.2)是三处显式移植偏差,**不在** golden 对照集内体现(对照集锁 harness2 原样行为),由各自专项测试覆盖(`keepBaseInPool.test.ts`、`proposer` env 快照、`probeWorkspace.test.ts`)。
