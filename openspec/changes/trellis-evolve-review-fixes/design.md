# Design

## Context

见 proposal.md 的 Why(五处漂移)。实现现状(已核实):`applyApprovedProposals`(`src/evolve/apply.ts`)已实现"同一备份会话 + 档案查重 + effects 计算",唯一调用方是 `runEvolveJob` 步骤 6;`runDecision`(`src/commands/evolve.ts`)approve 只 `decideProposal` 翻状态并打印"批准不等于应用"。effects 在 `EvolveJobSummary.applied` 处被裁掉、apply-run 档案 payload 只有 `{runId, proposalIds}`;自动采纳通知在采纳门决策时(备份会话尚不存在)就定稿,回滚行只能是 `DEFAULT_ROLLBACK_HINT` 泛化指引。recorder 的 `handle` 在事件回调栈内同步 `appendFileSync`。

## Goals / Non-Goals

**Goals:**
- 批准→应用闭环在同一命令内走完,失败可重试,不滞留。
- effects 与真实回滚标识进入档案与报告,全部可从档案重算。
- 信号落盘移出事件处理热路径,不改变信号语义(白名单、擦除、坏行容错、off 零副作用)。
- 文档与代码注释与真实执行体一致。

**Non-Goals:**
- `trellis evolve run` / `import`(trellis-evolve-run-backfill)。
- 引擎两处焊点(prompt surface 注册、`CHANNELS`)解除——等第三 surface 真实需求。
- `evolve apply` 的 `--dry-run`(spec 未要求;真需要时随 run-backfill 的 dry-run 语义一并对齐)。
- GUI 结构变更、通知渠道接入、auto-A 级别语义、L1/风险分级判定。

## Decisions

1. **approve 内联应用 + `evolve apply` 兜底**(而非拉起一次性应用作业、也非只加 apply 命令)。理由:批准发生在交互式终端,当场给出"写了什么、何时生效、怎么回滚"是闭环该有的反馈;复用 `applyApprovedProposals` 同一写入路径(备份会话、档案查重、幂等重放),无新进程、无新档案形态。拉起后台作业会把反馈拆到不可见处;只加 apply 命令则"批准→应用"仍差一步用户必须知道的命令。
2. **互斥复用既有单飞作业锁**(`trigger.ts` 的 `acquireJobLock`),不新增第二把锁。CLI 应用路径短暂持锁,锁被运行中作业持有时应用暂缓并告知(spec"作业运行中暂缓应用");决策(翻状态)不持锁,不被作业阻塞。备选的独立 apply 锁被否:要的互斥语义恰是"作业应用步骤 ↔ CLI 应用",job 锁天然覆盖,两把锁反而引入排序问题。
3. **effects 入档就地扩 payload**:apply-run 档案 payload 增 `effects[]` 与 `syncExitCode`,`EvolveJobSummary.applied` 增 `effects`(jobMain 整体入档自动携带),`reportView` 的 apply-run 分支按 `effects` 追加时间线说明,旧档案无此字段时如实跳过、不伪造。备选"单独 archive kind"被否:生效说明是应用运行的属性,拆开反而难回放。
4. **回滚标识在应用后重写通知**:采纳门决策时备份会话不存在,通知保留泛化占位;应用拿到真实 `runId` 后由 `risk.ts` 的纯函数 `retargetNotificationRollback` 只重写"回滚:"行。备选"应用后重建通知"需要把 reason/ruleId 塞进通知对象,改动面更大;格式由 `buildNotification` 单点控制,重写规则用前缀匹配并以单测锚定。
5. **recorder 队列化批量落盘**:`handle` 只入内存队列并 `setImmediate` 合并当轮事件,一次 `appendFileSync` 批量写多行;暴露 `flush()` 供测试与收尾。会话边界事件(session_start/session_end)同步收口——边界事件正是触发判定的运行点(补偿判定/会话结束判定),判定必须看得到含当前边界事件在内的全部已记录信号;热路径(工具调用)保持异步,❌4 的修复面不受影响。备选"每事件异步 write"不减 syscall;"保留同步"不动热路径。信号非审计级语义既有(读取侧坏行容错、注释已声明),崩溃丢当轮缓冲可接受。
6. **不动「管理面命令不触发进化循环」主 spec**:现文禁的是"触发观察、提案或 probe",批准/应用是执行用户决策,不在禁列。与 run-backfill 并存的措辞冲突("其余管理面命令保持零副作用")在其 delta 加豁免从句解决——两个 delta 不在同一 requirement 上互相覆盖。
7. **纠偏措辞的口径**:把"作业体即移植引擎的一次运行"改为"作业体是 rule-based 治理流水的一次运行;引擎内核 golden 锚定、生产未消费,随 L2/探针任务集接入"。保留移植史实,不删除、不夸大。

## Risks / Trade-offs

- [CLI 应用与运行中作业并发双写] → 单飞锁互斥 + 暂缓告知;即便极端竞态,档案查重与编辑幂等(write-file 整文件、remove-symlink 幂等)兜底。
- [recorder 崩溃丢当轮缓冲] → 信号本非审计级(读取侧已容忍坏行),批量窗口至多一个事件循环 turn;需要审计级时再改 WAL,不在本期。
- [通知回滚行字符串重写脆弱] → 格式由 `buildNotification` 单点生成,重写只匹配 `回滚:` 行前缀,单测锚定完整通知文本。
- ["批准≠应用"→"批准即应用"是可见行为变化] → USAGE、输出文案、文档同步改;非交互环境批准依旧被拒,受影响面仅交互用户,属修复而非破坏。
- [报告形状增量字段] → `counts.approvedUnapplied`、`applied.effects` 纯增量,GUI/sidecar 透传;全量测试跑过 sidecar 断言确认无字段白名单冲突。

## Migration Plan

无数据迁移。旧 apply-run 档案无 `effects` 字段,reportView 容错跳过。行为回退只需 revert 对应提交;档案字段为增量,无需回滚步骤。

## Open Questions

(无——影响实现的取舍均已决;deferrable 项已列入 Non-Goals。)
