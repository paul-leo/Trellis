# Golden 对照集:harness2 移植正确性的锚

本目录存放 Python 原版 harness2 的确定性运行产物,作为 TypeScript 移植
(`packages/evolve-engine/`)的同输入比输出对照。移植各模块时,TS 实现须在相同
输入下产出与本对照集一致的结果(路径占位符除外)。

## 来源与可复现方式

- **来源**:harness2(google-research,Apache-2.0),本地 checkout
  `~/www/morphix-research/sources/harness2`,commit
  `1cfe254e8d25b15f37048c3730134686abe60335`(2026-10-13)。
- **运行路径**:`harness2/cli/demo.py` —— DemoAdapter + DemoProposer,完全确定性
  的本地适配器(脚本化编辑与选择,无模型服务、无网络、无第三方依赖)。任务是
  两个账本求和(`ledger-1`、`ledger-2`),k=2,两种模式(agg/seq)都跑。
- **复现命令**(在任意隔离目录执行,Python ≥3.12,<3.14):

  ```bash
  PYTHONPATH=<harness2 checkout 路径> python3 -m harness2.cli.demo \
      --output <输出目录> --k 2 --mode both
  ```

  预期输出:`2 tasks completed; 0 failed`,28 次执行、32 次 editor 调用。

- **归一化规则**:产物中唯一的不确定因素是输出目录的绝对路径。对照前把
  `<输出目录绝对路径>` 替换为 `<RUN_ROOT>`(本对照集已归一化)。
- **已验证的确定性**:2026-10-24 两次独立运行,经同一抽取规则与归一化后
  1032 个文件逐字节一致(diff 为空)。

## 目录布局与对照锚点

| 路径 | 内容 | 锚定的移植模块(tasks 组) |
|---|---|---|
| `demo.json` | 顶层 report(任务状态、execution_count、editor_calls) | report(6.1) |
| `runs/*/*/summary.json` | 每任务的完整账本:stages、ledger(R/expected_R/P/expected_P/usd 预算恒等式)、selections、similarity | ledger(3.1)、schedule/recursion(6.1) |
| `runs/*/*/selection/` | 选择器判定 `selection.json`(chosen_id/chosen_label/匿名映射)+ 选择器 prompt `task.md` + 匿名候选 `candidates/` | selection(5.2)、prompts(4.1) |
| `runs/*/*/context/<stage>/task.md` | 各 stage 的 propose prompt 渲染结果 | spec/prompts(4.1) |
| `runs/*/*/harnesses/` | 每个 stage(base/inv1/inv2/dom1/dom2/agg1/agg2/c1/c2)的 harness 树 | tree(3.1) |
| `runs/*/*/reflection/` | `edits.md`(editor 输出)、`decisions/`(逐候选采纳判定)、`adoption.json`、`pool/*.diff`(树编辑 diff) | proposer(5.1)、tree(3.1) |
| `executions/` | 每次 rollout 的交付物(`answer.txt`)与轨迹(`trajectory.md`) | execute/read_trajectory 适配(9.3) |
| `library/` | 经验库回流产物(INDEX.md + EXPERIENCE.md + 采纳的 harness) | recursion/library(4.2、6.1) |
| `base/`、`sources/` | 适配器生成的 base harness 与任务输入(确定性输入) | 全部(输入锚) |

注:harness2 的目录惯例是 `demo-oc-agg2/` 下才写 `summary.json`(agg 与 seq
两种模式的结果合并在同一份 summary 的 `modes/` 下),`demo-oc-seq2/` 目录无
独立 summary——这是原版布局,不是缺漏。

## 有意排除的部分

- `runs/**/context/**` 中除 `task.md` 外的文件(source/harness/rollouts/decisions
  的逐 stage 拷贝):它们与本对照集中其他位置的内容重复,体积大、无新信息。
- `runs/**/reflection/**/rollouts/`、`harness/`、`source/`:同上,重复材料。
- `*.lock`:进程内锁文件,无对照价值。

## 使用约束

- prompt 模板语言已按 design Open Questions 定案:**原样保留英文**(tasks 1.2)。
  若未来中文化,本对照集须全部重建。
- 本对照集是研究资产的可复现快照,不含任何凭据;demo 路径不接触网络与模型服务。
- 移植偏差(base 留池 `keepBaseInPool`、凭据 env、无绕过标志)不在本对照集中体现;
  它们是 TS 侧的新增行为,由各自 task 的专项测试覆盖。
