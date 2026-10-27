# Proposal

## Why

自我进化阶段一已交付完整的事件链(信号 → 提案 → L1 前闸 → 批准 → 应用 → lesson),但全部记录只在 JSONL 档案与 CLI 文本里:用户看不见"进化到底做了什么、有没有用"。没有可视化,observe/propose 级别开启后用户无法建立信任,auto-A 的准入评估(需要有人监督的运行证据)也缺少承载面。

## What Changes

- 管理面新增**只读数据出口**:`trellis evolve status --json` 与 `trellis evolve report [--json]`,把 archive/pending/级别策略聚合为结构化的进化时间线(触发判定、提案、L1 verdict 前后测量、决策、apply-run、lesson、job-run),供 CLI 人类可读输出与 GUI 共同消费——单一计算源,不引入第二份独立计算。
- GUI(`packages/gui`)新增**进化仪表盘页**:经 sidecar 只读路由消费上述 JSON,展示三段——可追踪事件时间线(每条提案从发现到应用/拒绝的全链)、优化内容(每条提案的修复前 → 修复后真实测量差集与编辑清单)、趋势(发现解决数、提案采纳/拒绝率随时间)。
- **指标诚实性原则**入规:只展示真实测量(doctor findings 差集、计数、比率);不合成数值评分,分数轴待 L2 探针任务集落地后另行变更。
- 不新增任何写路径;不改触发/提案/应用语义;默认 off 不变。

## Capabilities

### New Capabilities

- `evolve-visualization`: 进化过程的可视化呈现——时间线可追踪性、优化内容的前后测量展示、趋势指标,以及指标诚实性约束(禁合成评分)。

### Modified Capabilities

- `self-evolution`: 管理面命令新增只读 JSON 数据出口(`status --json`、`report`),保持"不触发进化循环"与"不含凭据材料"约束。
- `gui-sidecar-api`: 新增进化视图的路由要求——与既有"read views mirror existing command output"一致,进化视图数据必须镜像 `trellis evolve report --json` 的输出。

## Impact

- `src/commands/evolve.ts`:新增 `--json` 与 `report` 子命令(纯读,零副作用)。
- 新增 `src/evolve/reportView.ts`(聚合 archive/pending/policy → 结构化报告;消费者内部,不越 10.3 边界)。
- `packages/gui/sidecar`:新增只读路由;`packages/gui/src`:新增仪表盘页。
-  specs:`self-evolution`、`gui-sidecar-api` 增量;新增 `evolve-visualization`。
- 不动:引擎包、触发器、作业体、备份/回滚、extensions 清单。
- 前置事实:GUI 当前零 evolve 引用(全新页面,非改造)。
