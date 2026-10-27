# Design

## Context

动机见 proposal.md(北极星定案:任务域=真实任务蒸馏的考题,harness2 引擎原样入环)。现状要点:

- `packages/evolve-engine` 已是 harness2 core 的逐行 TS 移植(golden 锚定、零 runtime deps),经 `Substrate` 协议与 `BenchmarkAdapter` 契约对外接任务域;生产尚未消费它。
- 适配参照已精读(harness2 源 checkout 只读):`core/spec.py` 的 `BenchSpec`(frozen 值)+ `BenchmarkAdapter` 协议(`tasks/domain_of/task_prompt/task_files/execute/delivered/trajectory/deliverable_*/base_harness/validate_tree/score`);`substrate/` 5 方法(`surface/materialise/execute/read_trajectory/preflight`);LAB worked example(`task.json` 形状 `title/work_type/tags/instructions/deliverables/criteria`,`criteria` 单点读入即 `pop`、`leak_globs=("task.json",)` 绊线);穷人沙盒机制(`third_party/lab_runner/.../run_codex_lab.py`:scratch 拒绝越界、源材料 0444、per-run CODEX_HOME 重定向、`timeout --kill-after` SIGKILL、metrics.json 最后写);judge 数据形状(`n_passed/n_criteria/all_pass`,失败 None)。
- 既有自我进化生产面:观察信号(元数据白名单)、rule-based 治理流水、风险分级/人批/备份回滚安全壳、手动触发与历史回填(run-backfill)。

## Goals / Non-Goals

**Goals:**
- 引擎零改动接入:一切 Trellis 特有物落在 adapter/substrate 实现;引擎保持可被其他宿主复用(三轴分离)。
- 蒸馏与验证的安全边界:永不重放原任务、副作用 mock、出网封锁、答案键隔离。
- 成本可控且可配置:账本恒等式 + 上限 + 三角色模型配置 + 手动触发铁律。

**Non-Goals:**
- 不改引擎包任何代码(含 prompt 文本);不发布引擎公开包(阶段二另议)。
- 不做容器级沙盒(穷人沙盒先行;OrbStack/Docker 等跑不可信代码或并行 k 候选时再上,harness2 同款取舍)。
- 不做蒸馏的全自动质量保证(LLM 幻觉风险靠质检闸+爆炸半径控制,不追求完美)。
- 不动观察信号层与既有安全壳(风险分级/人批/备份回滚原样复用)。

## Decisions

**D1 考题存储形状对齐 LAB `task.json`,六要素落位。** 每题一目录 `evolve/questions/<ws|shared>/<slug>/`:`task.json`(title/work_type/tags/instructions/deliverables/criteria + `side_effects` 副作用声明 + `process_notes` 过程注记)、`documents/`(源材料,只读)、`reference/`(参考交付物)。`criteria`(rubric)沿用 LAB 纪律:**单点读入即剥离**(adapter 的 `task_prompt` 永不含 criteria),`leak_globs=("task.json","reference/")` 泄漏绊线双保险。弃"自造考题格式"(会重发明 prompt 卫生/泄漏防护)。

**D2 适配面落位:`src/evolve/exam/` 实现 `BenchmarkAdapter` + `SubstrateLike`,经工厂接 `schedule.run_sweep`。** 对照 harness2 的 `cli/_common.make_adapter` seam——宿主只需一个 adapter 类 + 一行调用,proposer/selection/library/judge 全在 core 侧。`BenchSpec` 值我们组装:`name="trellis"`、`domain_word="workspace"`、`install_mode` 取 `workspace_agents_md` 系、`channels.proposer/selector` 由配置段解析(对应 `ChannelSpec`)、prompts 的 yardstick/selection_checks 用 harness2 原文(英文默认,含"用户请求是标尺"与过程质量检查项)。弃"改引擎加宿主钩子"(破坏可复用性)。

**D3 执行 launcher=穷人沙盒 + 副作用 mock 表,机制照抄 run_codex_lab.py。** `execute` 委托我们自己的 launcher:scratch 根拒绝越界路径、临时 workspace + 重定向 agent HOME(candidate 配置渲染装入)、源材料 0444、`timeout --kill-after` 进程组 SIGKILL、run 目录 `metrics` 最后写(死链不缓存)。**mock 表**在工具层拦截:副作用声明(考题字段)→ 工具分类表(发送/部署/删除/外呼 → mock),mock 落沙盒记录(mock outbox 等),交付物只取 `output/` 产物;出网默认封锁(仅模型 API 端点;阶段一用代理/环境重定向 + 提示词约束,容器级网络隔离后置)。多 agent(claude code/codex/pi)各一个薄 launcher(命令行形态差异隔离在这一层)。弃"提示词约定不真执行"(约束不是保证)。

**D4 蒸馏两档:零花费线索采集(自动)+ LLM 成形(手动档)。** 事件触发可做的是"观察 + 蒸馏线索采集"(标记值得蒸馏的会话、抽工具元数据/过程注记,零模型调用);考题六要素成形(尤其 rubric/参考交付物提炼)是 LLM 工作=花钱动作,归入手动触发档(铁律)。质检闸(可重跑性/rubric 二值可判/脱敏/禁词/副作用声明完备)全为规则检查,零花费。弃"蒸馏全自动 LLM"(违反零花费铁律)与"纯规则蒸馏"(rubric 质量不够,判不了过程质量)。

**D5 judge=rubric 二值判据,None 语义照搬。** `score(run_dir, task_id)` 返回 `{n_passed,n_criteria,all_pass}` 或 `None`;judge 模型独立可配;打分落 `judge.log`+`scores.json` 进运行目录;None 不进分母。选择侧永远不读这些文件(泄漏绊线挂证据组装处)。

**D6 预算账本换算进 evolve.yaml 执行段。** `evolve.yaml` 增 `execution:` 段:`exam_session_cap`(缺省 8)、`usd_cap`、`k`(候选数)、`models: { proposer, executor, judge }`。引擎账本 R=4k/P=3k 恒等式由 core `ledger.assert_identity` 原样执行;我们的轮=一次 `run_task` 的适配域。手动触发铁律在触发层强制:考题验证轮与付费提案只走 `trellis evolve run --exam`(或人批时机),事件路径只挂观察/线索订阅者。

**D7 与既有生产面的分工。** rule-based 提案通道降级为兜底(引擎轮之外的零花费发现通道,保留);L1/机械校验移入 `validate_tree` 插槽(引擎重试反馈同款"原样喂回");引擎轮采纳改动走既有安全壳:风险分类 → B 类人批(TTY 门)→ `applyApprovedProposals` 备份会话写入 → 生效报告。经验库(engine library)与 lesson 档案并存:库是引擎侧跨任务回流,lesson 是宿主审计,同一采纳事件两处记录不合并。

**D8 采纳判定的"防自欺"继承 harness2 两段式。** 选择(盲选)与判分(judge)物理隔离;k=1 时差距是噪音底线的警告由 report 层输出;KEEP_BASE/选中基线=不采纳的语义在引擎原生支持(`chosen_is_base`),适配层不加戏。

## Risks / Trade-offs

- [LLM 蒸馏幻觉 → 毒化题库] → 质检闸全规则化;考题爆炸半径=沙盒内预算;坏题最多浪费一轮验证,应用前人批兜底;题库条目带蒸馏来源(会话指纹)可追溯删除。
- [mock 表漏拦副作用工具] → 副作用声明完备性质检(声明未覆盖的工具类拒入库)+ 出网封锁兜底 + 沙盒 scratch 拒绝越界;新 agent/新工具先补表再放行。
- [本地 agent CLI 形态漂移(claude/codex/pi 版本差异)] → 每 agent 薄 launcher + `preflight`(花钱前健康检查,harness2 同款);preflight 失败带修复命令即停。
- [成本失控] → 账本恒等式 + session/USD 上限 + 手动触发铁律;k 与上限默认保守。
- [k=1 噪音误判] → report 层噪音底线警告;k≥2 才谈效果结论(报告措辞约束)。
- [隐私泄漏进题库] → 保结构去内容 + 脱敏扫描 + 答案键隔离 + 防注入绊线(四道,前三道在蒸馏/质检,第四道在证据组装)。

## Migration Plan

无状态迁移:题库/运行目录均为新目录;`execution:` 配置段缺省即用;老档案/信号/提案不变。回滚 = 不跑考题验证轮即回到现状(rule-based 流水与安全壳原样在);引擎包未改,无版本耦合。

## Validation

- 单测(fake substrate / stub launcher):六要素蒸馏、质检闸逐项拒收、晋升幂等、mock 表拦截、源材料只读、出网拒绝、轨迹含错误段、账本恒等式、None 不进分母、泄漏绊线拒证据树。
- 集成(真 CLI + 穷人沙盒,预算内小样本):蒸馏 → 入库 → 手动跑轮 → 盲选 → 人批 → 备份回滚,断言原任务副作用未发生(mock outbox 有记录、真实外呼零)。
- 回归:引擎 golden 175 不动;既有 evolve 套件(管理面/触发/导入)零回归;事件触发路径零付费调用断言。
