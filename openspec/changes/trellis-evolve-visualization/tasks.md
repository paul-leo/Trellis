# Tasks

## 1. 聚合层(消费者内部,纯读)

- [x] 1.1 `src/evolve/reportView.ts`:`buildEvolveReport(homeDir)` 聚合 archive + pending + 级别策略 → `EvolveReport`(levels / counts / timeline / trends / jobRuns / notices);timeline 按提案 id 关联 proposal/verdict/decision/apply-run/lesson 档案,缺口如实标注;单元测试(完整链、L1 拒绝终止链、无 verdict 标"无测量记录")。
- [x] 1.2 趋势指标:累计发现解决数、提案采纳率/拒绝率、作业运行/失败次数,每条带口径说明;空态(从未运行)有专门形状;单元测试含"指标可从档案重算"断言。
- [x] 1.3 只读零副作用断言:聚合前后档案行数/信号目录/pending/evolve.yaml 逐字节不变。

## 2. CLI 出口

- [x] 2.1 `trellis evolve status --json`(同聚合子集)与 `trellis evolve report [--json]`;人类可读 report 渲染时间线与趋势;USAGE 更新。
- [x] 2.2 测试:JSON 合法且与人类可读输出数值一致;零副作用(spec 场景);非 TTY 可用(只读出口不设 TTY 门)。

## 3. GUI

- [x] 3.1 sidecar:`routes/read.ts` 加 `GET /api/evolve/report`,内部调 `buildEvolveReport`(同源,不另算);路由测试(sidecar 现有测试同风格)。
- [x] 3.2 前端 `EvolutionView.tsx`:趋势条 / 优化内容卡(前后 finding 差集 + 编辑清单)/ 提案时间线;`App.tsx` nav 注册;空态=未开启指引;未知字段忽略、缺字段显式空态。
- [x] 3.3 GUI 冒烟测试(`App.smoke.test.tsx` 同风格)覆盖新 view 的渲染与空态。

## 4. 收口

- [x] 4.1 文档:`docs/self-evolution.md` 增"可视化"节(数据口径、指标诚实性原则);`docs/roadmap.md` 一行。
- [x] 4.2 `openspec validate trellis-evolve-visualization --strict`;宿主 `npm test` + `tsc --noEmit`;GUI 测试;引擎不涉(无需重跑 golden)。
- [x] 4.3 spec-test-mapping:新增场景 → 测试映射(沿用归档变更的映射表格式)。
