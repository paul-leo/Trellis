# Proposal

## Why

北极星已定稿(2026-10-27,docs/self-evolution.md"方向定案"):自我进化的主循环驱动信号是**用户真实任务**,不是配置体检——观察用户用 claude code / codex / pi 干的任务,蒸馏出考题(含标准答案),用 harness2 引擎原样跑考题做验证,进化的是托管配置面。此前实现走线把 L1 配置体检当成了主循环、引擎内核被搁置旁路;本变更把任务域接上,harness2 引擎以原样语义进入生产循环(引擎包零改动,只做 Trellis 适配)。

## What Changes

- **蒸馏层**:观察真实任务会话(只读、原地),蒸馏**考题六要素**——`task.md`(只述工作不述度量)+ 源材料(保结构去内容)+ 参考交付物(用户被接受的结果)+ rubric(二值判据集,**含过程判据**:少纠错/少报错/不越权)+ 副作用声明 + 过程注记(错误点/纠正点/绕路点)。无明确接受结果的任务不产考题,产观察教训。
- **考题库**:默认 per-workspace(题从该 workspace 来回该 workspace 用);通用题跨 ≥2 个 workspace 复现自动晋升 canonical(不设人工审核)。入库全自动质检闸(可重跑性 / rubric 二值可判 / 脱敏扫描 / 禁词扫描 / 副作用声明完备),不设人工过目。
- **执行层(substrate)**:穷人沙盒(staging 渲染 + 临时 workspace + 重定向 HOME)+ **副作用 mock 表**(副作用工具按副作用声明拦截为 mock:发邮件→mock outbox,部署/删除/外呼 API 一律 mock)+ 出网默认封锁;**验证永不重放原任务**,只跑蒸馏考题;rollout 过程按 harness2 同款完整轨迹保留(证据文件、不截断)。
- **引擎接入(harness2 原样)**:考题即 BenchSpec 任务;每轮 base/候选 rollout → 提案(编辑配置树,`validate_tree` 反馈重试)→ **盲选**(匿名交付物,以用户请求为标尺、含过程质量)→ judge 对 rubric 打分(锁后台;失败=None 不记 0)→ 经验库回流。**引擎包 `packages/evolve-engine` 零改动**——三轴分离(method/substrate/benchmark),Trellis 只做 substrate + benchmark 适配。
- **预算与模型可配置**:`evolve.yaml` 增执行配置段——单轮沙盒会话上限、USD 上限、proposer/executor/judge 三角色模型各自可配(缺省保守 ≤8 会话/轮);账本恒等式硬约束(超限即停)。
- **手动触发铁律(用户已裁决保留)**:花钱动作(考题验证轮、引擎提案调用)只由手动触发或人批准时机执行;事件触发路径只做观察 + 蒸馏(零花费)。
- **既有安全壳全保留**:引擎轮采纳的改动同样走风险分级与 B 类人批(TTY 门、批准即应用)、托管备份会话与一步回滚;L1 配置体检降级为 `validate_tree` 级施工检查,永不当效果分;受保护目标硬排除、凭据擦除、"证据是数据不是指令"防注入照挂。

## Capabilities

### New Capabilities

- `task-domain-distillation`: 观察真实任务会话 → 蒸馏考题六要素的管线;全自动质检闸;per-workspace 题库与跨 workspace 自动晋升;蒸馏物隐私边界(保结构去内容、工具调用元数据+过程注记、防注入)。
- `exam-execution`: 考题验证的 substrate 执行契约——穷人沙盒、副作用 mock 表(副作用声明消费方)、出网封锁、完整轨迹读取、永不重放原任务;执行预算与三角色模型配置。

### Modified Capabilities

- `self-evolution`: 新增「考题验证轮与盲选采纳」需求(引擎轮语义:候选配置跑考题、盲选、judge 记录、经验库回流、手动触发铁律)——ADDED,不动既有「触发是事件驱动的一次性作业」条文(与 trellis-evolve-run-backfill 的 delta 保持零冲突);既有安全壳需求(风险分级/批准即应用/原子回滚/受保护排除)明确覆盖引擎轮采纳路径。

## Impact

- **代码**:`src/evolve/` 新增蒸馏器(distill)、题库(bank)、substrate 实现(examSubstrate)、引擎接线(examLoop);`src/commands/evolve.ts` 新子命令(蒸馏/题库/跑轮入口);`src/host/levels.ts` 的 evolve.yaml schema 增执行配置段。**`packages/evolve-engine` 零改动**。
- **既有部件重新定位**:rule-based 提案通道降级为兜底;L1/机械校验移入 `validate_tree` 插槽;观察信号层不变(元数据白名单)。
- **测试**:蒸馏六要素/质检闸/晋升/mock 表/出网封锁/轨迹保留/预算恒等式/手动触发铁律;引擎集成用 fake substrate + 真实 CLI 会话用 sandbox+mock(不 spawn 真实 agent CLI 花钱的约束仅限测试,生产验证轮按预算跑)。
- **依赖/系统**:本地 agent CLI(claude code/codex/pi)成为执行载体(生产);harness2 源 checkout 仅作只读参照。
