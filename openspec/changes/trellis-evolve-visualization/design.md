# Design

## Context

进化子系统的全部状态在三个只读来源:`~/.trellis/evolve/archive/records.jsonl`(append-only 事件链:trigger-decision / proposal / verdict / proposal-decision / apply-run / lesson / job-run)、`evolve/pending/*.json`(提案当前状态)、`evolve.yaml`(级别策略)。约束:

- 消费者边界(10.3):`src/evolve/` 只依赖 `src/host/*` 与 node 内置,不 import `src/commands/*`、`src/lib/*`;聚合逻辑放进 evolve 内部,CLI 只是渲染壳。
- `gui-sidecar-api` 既有规约:读视图必须镜像 CLI 同源数据,不得第二份独立计算——所以 GUI 消费的就是 `evolve report --json` 的同一份聚合函数。
- sidecar 路由模式:`routes/read.ts` 的 `createReadRoutes(homeDir)` 只读路由族;前端 `src/views/*.tsx` 经 `App.tsx` 的 nav 注册。
- L1 verdict 档案(每提案两份:baseline/candidate)携带 before/after 检查面,是"前后测量"的数据源;job-run 档案含 summary(signalsConsidered、enqueuedIds、autoAdoptedIds、notices、error)。

## Goals / Non-Goals

**Goals:**
- 单一聚合函数(纯读)→ CLI 文本 / CLI JSON / sidecar 路由 / GUI 页四处共用。
- 时间线可追踪到备份会话标识(回滚入口)。
- 趋势指标全部可从档案重算,口径随数据导出(每条指标带来源说明)。

**Non-Goals:**
- 数值评分/健康分(等 L2 探针任务集,独立变更)。
- 实时推送(轮询/手动刷新即可,档案是低频只追加)。
- 档案压缩/轮转(规模无感,观察到再说)。
- agent 接口面 transport(agentView/reportUserCorrection 的后置项,不属于本变更)。

## Decisions

1. **聚合落点:`src/evolve/reportView.ts`(消费者内部)**。`buildEvolveReport(homeDir): EvolveReport` 纯读三来源,产出 `{ levels, counts, timeline: ProposalTrace[], trends, jobRuns, notices }`。CLI `evolve report` 与 sidecar 路由都只是它的渲染/传输壳。备选:放 `src/commands/evolve.ts`——否,sidecar 不能 import commands(会拖入整 CLI);放 GUI——否,违反 gui-sidecar-api 的同源规约。
2. **JSON 形状即契约**:`EvolveReport` 的类型就是 GUI 的 Props 源;变更它必须过本 spec。`status --json` 复用同聚合的子集,不另造形状。
3. **前后测量的呈现语义**:提案 → verdict 的关联键是 proposal id(verdict 档案 payload 含 proposalId 与 baseline/candidate 的 finding 集合);呈现"resolved = baseline 中 targetIds 且 candidate 消失"的差集,无 verdict 档案的提案标"无测量记录"。不推断、不插值。
4. **GUI 页 = 一个新 view + 一个只读路由**:`routes/read.ts` 加 `GET /api/evolve/report`(内部调 `buildEvolveReport`),前端 `EvolutionView.tsx` 三段式(趋势条 / 优化内容卡 / 时间线)。图表用轻量 SVG 手绘(现状无图表库依赖,不引)。
5. **空态与未开启是一等状态**:无 `evolve.yaml` → 仪表盘显示"未开启 + 如何开启"指引,不显示空图。

## Risks / Trade-offs

- [档案长期增长导致聚合变慢] → 本期全量同步解析(与触发器同款,O(n) 已知观察项);趋势按天聚合后数据量恒定,真出问题再引入增量缓存。
- [时间线关联错配(同名 id 复用)] → 提案 id 由 `rule-<findingId>` 派生且 pending 去重,关联以"档案中出现的首条 proposal 记录"为锚,重放不另起链。
- [JSON 形状演进破坏 GUI] → 形状变更走 spec delta;GUI 对未知字段忽略、缺字段显式空态。

## Migration Plan

纯新增面:无迁移。默认 off 不变;未开启时所有出口返回空态形状。回滚 = 删路由/视图/子命令,不触碰任何既有写路径。
