# Tasks

## 1. 蒸馏层(D1/D4)

- [ ] 1.1 考题存储与类型 `src/evolve/exam/question.ts`:六要素落位(task.json 带 `side_effects`/`process_notes`,documents/ 只读源材料,reference/ 参考交付物),`leak_globs` 常量与单点读入剥离契约;验证存储往返单测。
- [ ] 1.2 蒸馏器两档 `src/evolve/exam/distill.ts`:零花费线索采集(会话筛选 + 工具元数据/过程注记抽取,无模型调用)+ LLM 成形档(手动触发;task.md/rubric/参考交付物提炼;无被接受结果不产考题);验证两档花费边界(线索档零调用)。
- [ ] 1.3 全自动质检闸:可重跑性 / rubric 每条二值可判 / 脱敏扫描 / 禁词扫描 / 副作用声明完备,不过闸拒入库并记因;验证逐项拒收用例。
- [ ] 1.4 题库归属与晋升 `src/evolve/exam/bank.ts`:per-workspace 题库、跨 ≥2 workspace 复现自动晋升共享库(幂等、保留原归属、事实重验标记);验证晋升/幂等/隔离用例。
- [ ] 1.5 蒸馏层测试汇总:六要素完备、保结构去内容、防注入(指令形态文本只作数据)、答案键不进证据面绊线。

## 2. 执行层(D3)

- [ ] 2.1 substrate 实现 `src/evolve/exam/examSubstrate.ts`:surface/materialise/execute/read_trajectory/preflight 五方法;穷人沙盒 launcher(scratch 拒绝越界、临时 workspace、重定向 agent HOME 装入 candidate、源材料 0444、`timeout --kill-after` 进程组 SIGKILL、metrics 最后写)。
- [ ] 2.2 副作用 mock 表:副作用声明 → 工具分类 → mock 记录(mock outbox 等);出网默认封锁(仅模型 API 端点);验证 mock 拦截 / 出网拒绝 / 源材料只读用例。
- [ ] 2.3 轨迹读取:capture 格式 → 共享 `[ACTION]/[OBSERVATION]/[ERROR]` 语法,不截断(仅单观测内 obs_trunc);验证错误段保留。
- [ ] 2.4 preflight:花钱前健康检查(agent CLI 在位、scratch 可写、mock 表覆盖当前工具面),失败带修复命令即停;验证 preflight 拒绝用例。
- [ ] 2.5 多 agent 薄 launcher(claude code / codex / pi 命令行形态差异隔离);验证各 agent 至少一条 stub 执行用例(不 spawn 真实 CLI 花钱)。

## 3. 引擎接入(D2/D5/D6/D8)

- [ ] 3.1 `BenchSpec` 组装 + `BenchmarkAdapter` 实现 `src/evolve/exam/trellisAdapter.ts`:tasks/domain_of(=workspace)/task_prompt(criteria 单点剥离)/task_files/execute/delivered/trajectory/deliverable_*/base_harness/validate_tree;验证 adapter 契约形状对照单测。
- [ ] 3.2 judge:`score` 返回 `{n_passed,n_criteria,all_pass}` 或 None(失败永不 0),judge.log + scores.json 进运行目录;judge 模型独立可配;验证 None 不进分母、判分在选择承诺之后。
- [ ] 3.3 接线 seam:工厂 + `schedule.run_task/run_sweep` 调用(k/modes 取配置);**引擎包零改动断言**(check-deps/golden 不动);fake substrate 集成:引擎完整跑一轮(基线→提案→候选→盲选→判分→经验)。
- [ ] 3.4 `evolve.yaml` `execution:` 配置段(session_cap 缺省 8 / usd_cap / k / models.proposer|executor|judge);验证配置解析与缺省值。
- [ ] 3.5 手动触发铁律:`trellis evolve run --exam`(或等价显式入口)才跑考题验证轮;事件路径零付费调用断言;超预算即停 + 账本恒等式违反即终止。

## 4. 安全壳与回流(D7/D8)

- [ ] 4.1 引擎采纳接线:chosen 候选 → 风险分级 → B 类人批(TTY 门)→ `applyApprovedProposals` 备份会话应用 → 生效报告;验证选中基线不采纳、选择器失败不采纳、人批拒绝不写入。
- [ ] 4.2 双记录与呈现:engine library 回流 + 宿主 lesson 档案(同一采纳事件两处记录);report 透传考题轮与 k=1 噪音底线警告;验证报告措辞(不合成评分照旧)。
- [ ] 4.3 防泄漏/防注入绊线挂证据组装处(rubric/reference 混入即拒;指令形态文本按数据);验证绊线必红反例。

## 5. 收口

- [ ] 5.1 `openspec validate trellis-evolve-task-domain --strict`;宿主 `npm test` + `tsc --noEmit` 全绿;`packages/evolve-engine` golden 175/175 不动;GUI 不改(报告增量后置)。
- [ ] 5.2 文档:`docs/self-evolution.md` 生产接线节补考题轮;spec-test-mapping(场景→测试映射表,沿用既有格式)。
