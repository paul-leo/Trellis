# 自我进化:Trellis 的第二个子系统(想法沉淀)

> **状态:阶段一已交付(2026-10-26),默认 `off` 未对用户开启。** 2026-10-20 初稿按"借 harness2 方法论自设形态"起草;**2026-10-24 用户裁决改为直接做 harness2 的 TS 版本——移植引擎,而非再造形态**,同日定下打包两阶段(内部包先行);2026-10-24–26 按 `openspec/changes/trellis-evolve/tasks.md` 完成阶段一实现。可验证的行为约束在 change 的 `specs/` 里,**二者冲突时以 `specs/` 为准**。
> 本文是**想法与取舍**:是什么、为什么、边界在哪、已核实什么、还没定什么。

## 接手指南

**一句话现状**:阶段一(tasks 第 1–14 组)已交付:引擎移植为 workspace 内部包 `packages/evolve-engine/`(golden 对照 175/175)、托管扩展点、TrellisSubstrate 适配层、observe/触发、L4 治理与 fixture 端到端,宿主测试 1216/1216、`tsc` 干净、`openspec validate --strict` 通过、真机冒烟确认默认 `off` 零副作用。**生产接线已补齐(2026-10-26 收口)**:enable/disable 同步扩展清单、`activate` 订阅者包装(recorder + 触发器)、作业体引擎循环,见下文"生产接线"。后续是 `auto-A` 准入、L2/探针任务集、阶段二公开包。

**文档地图(各管什么,避免重复维护)**

| 文件 | 管什么 | 更新时机 |
|---|---|---|
| `docs/self-evolution.md`(本文) | 想法、取舍、已核实/未核实、路线 | 每次核实出新事实或做出决定 |
| `openspec/changes/trellis-evolve/proposal.md` | 为什么、改什么、影响面 | 范围变化时 |
| `…/specs/host-extension-points/spec.md` | 托管侧通用扩展点的行为契约 | 接口决定后 |
| `…/specs/self-evolution/spec.md` | 进化子系统的行为契约 | 行为决定后 |
| `…/design.md` | 技术决策、已核实现状(带代码位置)、风险、开放问题 | 决策或核实后 |
| `…/tasks.md` | 实施顺序与逐项验证方式 | 实施中勾选 |
| `docs/roadmap.md` | 一段指针 | 阶段变化时 |

**建议阅读顺序**:本文"一句话"与"核心原则" → `design.md` 的 Context(已核实表)与 Open Questions → 本文"生产接线"与 `tasks.md` 全貌 → 需要细节再读 `specs/`。

**接手后第一步**:读 `tasks.md`(阶段一全部完成)与 `spec-test-mapping.md`(58 场景→测试映射,创建 PR 时并入 PR 描述),然后看下文"生产接线"的边界说明(editor 通道未接、发现面=观察面等)。golden 对照集与复现方式在 `packages/evolve-engine/golden/`,是引擎后续改动的正确性锚。

**需要接手人特别留意的三件事**

1. **解耦是硬约束**:依赖只能是进化 → 托管。`packages/evolve-engine/`(引擎)不 import 任何 Trellis 代码;`src/evolve/`(适配+治理)只允许 import 引擎包与 `src/host/*`,有测试强制。任何让托管"知道"进化的改动都是方向性错误。
2. **带外批准目前不是完全可靠的**:有 shell 能力的 agent 理论上能执行管理面命令,TTY 检测只是启发式。`auto-A` 开启之前必须再评估(见 design 的 Risks 与 Open Questions)。
3. **覆盖范围有边界**:事件只来自经 gateway/runtime 投递的 agent,仅走原生渲染的 agent 没有工具调用事件。不要在文档或 doctor 输出里假装全覆盖。

**本草案的形成过程(便于判断哪些结论可信)**:最初按"用户运行 `trellis evolve` 命令触发"建模,被用户纠正为"环境式、跑在 runtime 上、与托管解耦、可选开启"后整体重写。命令式阶段遗留的"单备份会话写入""staging 复现层分裂"等需求已下沉为托管的公开接口。

## 一句话

Trellis 由两个**解耦**的部分组成:**托管**(让配置被正确投递并保持一致)和**自我进化**(让被托管的内容随使用变得更好)。进化是挂在 runtime 底座上的环境式能力,跑在其上的 agent 自己持续进化,可选安装、分级开启;它**不是**一条要用户去敲的命令。

## 为什么要做

托管已经覆盖 skills、MCP、指令、scope、memory,但托管内容的**改进完全靠人**。信号其实一直存在,缺的是把"信号 → 提案 → 验证 → 采纳 → 教训沉淀"闭环起来的机制。2026-10 的两个真实事故说明了这一点:

- workspace `.codex/config.toml` 重复键,让该项目的所有 Codex 会话静默失败约 19 小时,没有任何机制主动发现;
- PATH 上 0.12.0 旧入口遮蔽 0.16.0,把版本分叉误诊成 `servers.yaml` 配置错误。

两件事 doctor 都在事后补上了检查,但"事故 → 人发现 → 人修 → 人补检查"这条链全靠人。进化要缩短的就是这条链。

## 核心原则:两个子系统,一个窄接口

| | 托管 (Hosting) | 自我进化 (Evolution) |
|---|---|---|
| 职责 | canonical 内容被正确投递并保持一致 | 被托管的内容随使用变好 |
| 拥有 | canonical、adapters、gateway、backup、doctor、memory 管道 | 信号、提案、验证、风险门、lesson、运行档案 |
| 不知道 | 进化的存在 | 具体 agent 怎么渲染、怎么投递 |
| 缺席时 | 完全正常 | (本来就可选) |

- **依赖方向只有一条:进化 → 托管,绝不反向。** 卸载进化,托管行为逐字节不变。这比"功能开关"更强:它是**可选安装**。
- **引擎是移植的 harness2 core**(`packages/evolve-engine/`,阶段一内部包):只依赖 `Substrate` 协议(5 方法,83 行原样翻译),对 Trellis 零感知。`src/evolve/` 的 **TrellisSubstrate 实现协议**并经托管的 `host` 门面落盘。好处:引擎可用 fake substrate 独立测试、golden 对照不被宿主污染、将来换宿主(如 agent-framework)只重写适配层。
- 原自设的 `HostPort` 接口**作废**——harness2 已有验证过的协议签名,不自造接口。托管的 `scope.yaml`(怎么渲染)与适配层的"可编辑表面"声明(surface)各管各的,不合并。

```
TS 引擎(packages/evolve-engine,移植自 harness2 core,对 Trellis 零感知)
  schedule / recursion / selection / proposer / judge / context
  prompts / tree / runmark / ledger        ← 只认识这个协议 ↓
Substrate 协议(5 方法,83 行原样翻译)
  surface()          ───────→  Trellis 可编辑树 schema(能改什么、静默失效模式)
  materialise()      ───────→  staging 渲染(host 门面:scratch HOME + 临时 workspace)
  execute()          ───────→  探针会话(穷人沙盒 + 一次性 CLI 会话)
  read_trajectory()  ───────→  会话记录/轨迹 → 共享语法
  preflight()        ───────→  doctor 级花钱前自检
TrellisSubstrate(src/evolve,适配 + L4 治理)→ 托管
  host 门面(检查 / 备份会话写入 / 回滚 / staging)· 事件流 · memory 管道(通用扩展点)
```

## 环境式运行:触发、观察、通知、生效

Trellis 的 gateway 是按会话拉起的 stdio 进程,规范明确 **"without a resident daemon"**,所以进化也**不引入常驻进程**,靠事件驱动:

1. **观察**:被动加主动并行。被动 = gateway 路由层记录元数据(工具/skill/记忆的调用、耗时、错误类别);主动 = agent 在用户纠正时自己调用 `trellis.evolve.note` 上报。主动信号最贵、质量最高(例如一次"配置改反方向"的纠正)。
2. **触发**:会话结束(provider 的 `close()` 钩子)时判断信号量/冷却期(严重度加权留待后续变更,本期信号无严重度字段),满足则 detached 拉起**一次性**后台作业,单实例锁。
3. **提案 → 验证 → 过门**:见下节,即原五环的 Propose / Probe / Compose。
4. **通知**:pending 提案经 provider 暴露给 agent(`pending` 工具或 resource),agent 在会话里告知用户;doctor 与 GUI 也可查看。
5. **生效**:runtime 模式下 skills / instructions 由 provider 从 canonical 实时提供,采纳后**下个会话自然读到新版本,无需 sync**;只用原生渲染的 agent,采纳后触发 sync。
6. **分级开启**:`off`(默认)→ `observe` → `propose` → `auto-A`(仅 Class A 自动采纳)。粒度为全局默认 + per-agent + per-workspace,沿用 `onboard --memory on` 的显式选择方式,写进 canonical,doctor 可见,不静默开启。

CLI 退居**管理面**:`status | pending | approve | reject | enable | disable | rollback`,不再是触发器。

## 进化循环(五环)

```
Observe → Propose → Probe → Compose → Apply+Reflect
                                         │
          lesson 回流为下次 Propose 的上下文 ┘
```

- **Propose**:引擎 proposer 拉起 improver 会话(本机 CLI spawn;agent-bridge 为可选委派通道),产出结构化树编辑。editor 是**不可信输出**:引擎 `validate_tree` 机械复核,错误写成可执行散文喂回重试一次,再错丢弃;证据要求与 Class C 排除由 L4 治理层与 `surface()` schema 双重强制。**没有 evidence 链接的提案直接丢弃。**
- **Probe**:提案先写入 staging 候选(scratch HOME,按需加临时 workspace root),不动真配置。
- **Compose**:风险门,见下。采纳铁律:任何验收器结果不得差于 baseline,宁可不进化。
- **Apply+Reflect**:写入走一个备份会话,单点 `trellis rollback` 整体回滚;被采纳的编辑蒸馏成 lesson `{cue, lesson, evidence, confidence?}` 进 `memories/`,作为下次提案上下文(harness2 的 improvement harness)。

## 评测:怎么对比修改前后(最关键的一环)

harness2 的评分是**两段式且互相隔离**:选择(匿名对比、无 ground truth)与评分(checklist,选择承诺之后才跑)物理分离,选择器永远看不到评分材料。我们按"有无现成 oracle"分层:

- **L1 配置类 — 确定性差集,零 LLM**:baseline 与 staging 候选各跑 doctor / `sync --check` / secrets audit,可采纳 ⟺ 无新 finding ∧ 目标 finding 已消除 ∧ 其余不变。配置类的检查本身就是 ground truth,比 LLM 选择器更强也更便宜。两个事故都属这一类。
- **L2 内容类 — 沙盒执行 + 匿名 A/B**:同一道探针任务在 base 与 candidate 下各跑一次,交付物冻结后,以种子匿名 id 呈现给独立选择器(不给 verdict、不含评分字样、不标明哪臂是新)。选择器失败 / 任一臂未交付 / 选中 base ⟹ 一律不采纳。**一处刻意反转**:harness2 把 base 排除出候选池("构造上无法弃权",因为它必须进化);我们把 base **留在池里**,因为我们不能退化。
- **L3 成绩单**:一小组带显式 checklist 的探针,定期对已采纳修改跑 `n_passed/n_criteria` 看趋势。评分失败记 `None`,不计入分母,**永不记 0 分**;结果只给人看,不给选择器看。
- **缺口**:内容类(L2)缺**探针任务集**,这是真正的前置资产,比代码更难。来源优先级:真实事故复现题 > 用户纠正转化题 > 按 skill 领域合成题。因此路线先做 L1。

执行隔离:本机用"穷人沙盒"——`mkdtemp` workspace + staging 渲染配置 + 重定向的 agent 配置 HOME + 一次性会话,**沙盒保证每次执行干净可复现,对比本身发生在冻结的产物上,不在沙盒里**。容器(本机有 OrbStack)后置,等探针要跑不可信代码或需并行 K 候选时再上。

## 风险分级与护栏

分级由**代码按 kind + target 计算**,不信 editor 自报的 `risk_class`:

- **Class A**:可逆、零爆炸半径、证据确凿(如补一个 `${VAR}` 名、修复 doctor 已报告的 drift)——仅 `auto-A` 级别且 probe 通过时自动采纳,事后通知。
- **Class B**:skill/指令内容编辑、MCP 路由变更——永远人批。
- **Class C**:secrets、auth、受管 agent 集合、用户手写文件、`evolve` 自身配置——校验阶段拒绝,**连提案都不生成**。
- 无法分类 → 按 Class B。

环境式运行比命令式危险得多,必须有的护栏:

1. **被进化者不能批准自己的进化**:Class B 批准**只走带外通道**(CLI/GUI),agent 只能展示和提醒。否则传入 `confirm=true` 就能自批,批准形同虚设。
2. **层级隔离**:信号、提案、verdict、lesson 全部携带 `global | workspace(<root>)` 归属;跨层写入被拒;**单个项目的证据不自动升格为全局规则**(需另一上下文佐证或显式批准);workspace 编辑继承可提交约束(`${VAR}` 引用,绝不写凭据字面值——那个文件 git 跟踪在别人的仓里)。
3. **隐私**:观察只存元数据,不存 payload,并过 secrets 擦除。
4. **防自激**:evolver 自己的调用与编辑不进信号源。
5. **成本与频率**:委派 editor 有预算上限、冷却期、每日提案上限。
6. **会话中途漂移**:gateway 启动时 pin 住 canonical 版本摘要,采纳只在会话边界生效。
7. **并发**:信号只追加存储,evolver 作业单实例锁。
8. **失败收口**:probe / verdict / 选择过程的任何失败一律记为"不采纳",测量失败记 unknown,不当作通过。
9. **不 bypass 目标 agent 的审批与沙盒**:harness2 在宿主机上用 `--dangerously-bypass-approvals-and-sandbox`,这是研究代码的取舍,**我们明确不采纳**。

## 托管侧需要新增的通用扩展点

目前 SDK 只导出 `loadCanonicalSource`、`ALL_AGENTS`、`resolveScope` 与类型(只读),`trellis-sdk` spec 还禁止导出 adapters / commands 内部。进化要的能力托管侧都没有公开接口,所以接缝要新建,且必须是**通用扩展点,不带进化字样**:

1. **事件流**:会话开始/结束、工具调用已路由(仅元数据)。指标、审计同样可用。
2. **公开 `host` 子路径**:写入(带备份会话)、回滚、检查。不放开 `src/commands/*` 内部实现,而是新增明确的导出面。
3. **provider 外部注册约定**:`TrellisProvider` 已是开放接口(tools / resources / prompts / skill 条目 / `close()`),进化作为外部包注册自己的 provider,托管核心无需认识它。

"单备份会话写入""probe staging 复现层分裂"这类本属托管的能力,已在整合草案里下沉为 `host` 门面(备份会话内应用/回滚、staging、结构化检查);进化只调用,不拥有。

## 从 harness2 学到什么(已对照源码核实)

来源:`github.com/google-research/harness2`,本机副本 `~/www/morphix-research/sources/harness2`。

| 机制 | 出处 | 我们怎么用 |
|---|---|---|
| Propose–Probe–Compose,无 ground truth 的行为对比 | `core/proposer.py` `selection.py` | 循环骨架;L2 对比 |
| 两段式测量(选择与评分隔离) | `core/selection.py` `judge.py` | L2 选择器看不到评分材料 |
| 失败语义收口(judge 失败 = None;选择器失败 = 回退 base;preflight 带修复命令) | `judge.py` `selection.py` | 全局失败收口原则 |
| 指纹 + 身份守卫的复用 | `core/runmark.py` | probe 缓存键 = 被测切片 sha1 |
| 差异即数据(`SurfaceSpec`,frozen dataclass) | `core/tree.py` | "可编辑表面 + 静默失效模式"声明为数据 |
| 三轴正交 + 一格子一实例 | `core/spec.py` `benchmarks/workbuddy.py` | `HostPort` 与 probe adapter 的形态 |
| 穷人沙盒 | `substrate/codex.py:149-185` | probe workspace 边界 |
| 校验错误即 prompt(原样喂回作重试反馈) | `validate_tree` | editor 重试 |

**移植决定(2026-10-24 修订)**:无 PyPI 包、`harness2/__init__.py` 为空(无公开 API)意味着移植只能由我们做;但 `dependencies = []`(core 纯标准库)、无平台门控、Vertex 只是 spawn 子进程的环境变量,意味着 **core ≈5,650 行可整体直译为 TS**。Linux/Docker/benchmark 属评测资产侧,不移植;benchmarks 的对应物是自建探针任务集。~~移植方法论,不移植代码~~ → **移植引擎,再造宿主**。打包两阶段:阶段一内部包(不发 npm),阶段二等第二个消费者出现(与 agent-framework 整合是同一动作)。

## 已核实 / 未核实

| 已核实(读过代码或 spec;位置见 design.md Context) | 未核实 / 假设 |
|---|---|
| gateway 无常驻进程,client 断开即释放上游 | 全局记忆未启用时 lesson 回流的实际效果(本机记忆未开,`recordLesson` 报 `skipped` 而非 `failed`) |
| **所有工具调用(内建与上游)汇入同一咽喉点** `BuiltinRegistry.callTool`——事件总线已在此挂载(8.3) | 带外批准在 agent 有 shell 能力时的强度(TTY 检测只是启发式;`auto-A` 前必须再评估) |
| `RuntimeContext` 只有 `{agentId, homeDir}`,**无会话标识**——已由事件层生成,同进程一致(8.2/8.3) | L2 探针任务集来源与归属(真实事故复现 > 用户纠正转化 > 合成;canonical 还是 per-workspace 待决) |
| 关闭路径只处理 stdin `end`/`close` 与 SIGTERM/SIGINT/SIGHUP;**SIGKILL/崩溃不触发 `close()`**——下次启动补偿检查已实现(11.6) | `auto-A` 准入:需要多少次有人监督的运行才算"证明不误报" |
| 扩展加载机制与状态目录路径已定案并实现(8.1/8.6):清单 `~/.trellis/mcp/extensions.yaml` + `activate` 契约(阶段一:绝对路径/文件 URL),状态目录 `~/.trellis/evolve`;失败按 `manifest`/`invalid`/`import`/`activate` 阶段隔离,无清单零装载 | |
| 观察字段已定(9.4①):事件只含白名单元数据,载荷不入库,secrets 擦除后按进程分文件追加 | |
| skills/instructions provider 读取路径已核实(9.4②),结论入 design | |
| `TrellisProvider` 含 `close()` 与 skill 条目接口;host 门面已公开检查/备份会话/回滚/staging(8.5),SDK 根入口仍只导出只读面 | |
| harness2 各机制的行为(见上表) | |
| **发布配置(14.4)**:`packages/evolve-engine` 为 `private: true`、`version 0.0.0`、files 仅 `dist`+`NOTICE`;根 tarball `files` 不含 `packages/`,引擎只在 `devDependencies`,cli.ts 静态 import 链(112 文件)零触达引擎包——**阶段二启动条件未满足前不进任何 npm 发布配置**。注意差异:根 `prepublishOnly` 是 typecheck+build+test,**不含** `verify-pack`(独立 script,pack 真 tarball 装进无 devDependencies 的 scratch 冒烟) | |

## 已定倾向 / 待决

- **已定(2026-10-24)**:移植 harness2 引擎为 TS;打包两阶段(阶段一 `packages/evolve-engine/` 内部包、不发 npm,阶段二等第二个消费者、与 agent-framework 整合同一动作);prompt 模板原样保留英文(默认)。Class B 批准带外为主;后台作业由会话结束拉起而不靠外部调度器;先做 L1。
- **已定(同日,8.1/9.4)**:扩展加载机制(清单 + `activate` 契约,provider 与订阅者同面)与状态目录路径;观察元数据字段白名单(9.4①);provider 读取路径(9.4②)。
- **待决**:用户纠正的采集形态(手工 `note` vs 从会话收割);探针任务集放 canonical 还是 per-workspace;`auto-A` 之前需要多少次有人监督的运行才算"证明不误报";运行档案的轮转策略。

## 前置依赖

- agent-bridge 还有 5 个未完成项(委托存储、doctor 委托 section、Claude Code blocked、多跳、文档);editor 委派依赖 `runDelegatedCall`,不可用时 L1 可降级为 rule-based 提案。
- 全局记忆需启用(`trellis onboard --memory on`)才能让 lesson 回流有真实载体;本机目前未启用。
- 探针任务集(L2 的前置资产)。

## 分阶段路线

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | doctor oracle、backup/rollback、memory 管道、agent-bridge 委派原语 | 已就位 |
| P1 | **引擎移植**(阶段一内部包:golden 基线 → 按依赖图 6 层移植 → 对照验收);托管扩展点 | 已完成(引擎 175/175;扩展点 8.1–8.7) |
| P2 | TrellisSubstrate 适配层 + Observe/触发:环境式接入,`off`/`observe` | 已完成(第 9–11 组;默认 `off`;生产接线见"生产接线"节) |
| P3 | `propose` 端到端:L4 治理(证据提案、L1 前闸、带外批准、单会话写入) | 已完成(第 12–14 组;fixture E2E + 真机冒烟) |
| P4 | `auto-A`;内容类 L2(依赖探针任务集);lesson 回流提质 | 未开始(`auto-A` 准入门槛待决) |
| P5 | 递归预算(K 候选 parallel / K 步 sequential)、容器化 probe | 未开始 |
| 阶段二 | 引擎提升公开 npm 包 = agent-framework 整合(同一动作) | 等第二个真实消费者;发布配置已确认不夹带(见上表) |

## 明确不做

- 进化 Trellis 自身代码、secrets、auth、受管 agent 集合、用户手写文件。
- 让托管层依赖进化(依赖方向永远是进化 → 托管)。
- 绕过目标 agent 的审批 / 沙盒机制。
- 在没有现成 oracle 的类别上抢跑自动采纳(内容类必须等探针任务集)。

## 生产接线(2026-10-26 收口)

阶段一任务按各自验证标准通过后,14.4 核实时曾记录三处生产接线未连通,**已全部补齐并配测试**(宿主 1216/1216):

1. **`evolve enable|disable` 同步扩展清单**(design 8.1):级别升至 `observe` 及以上时向 `~/.trellis/mcp/extensions.yaml` 幂等写入条目(`id: evolve`,`load` 指向 `src/evolve/extension.ts` 的 activate 模块,dist/tsx 两种运行形态同款解析),置回 `off` 时移除;任一粒度(default/agent/workspace)仍有 observe+ 时条目保留(any-of 规则,细粒度闸在订阅者逐会话判定)。
2. **`activate(ctx)` 订阅者包装**(`src/evolve/extension.ts`):`off` 零订阅;`observe` 只挂 recorder(事件 → 信号,含 secrets 擦除与层归属);`propose`/`auto-A` 另挂触发器订阅者(会话结束判定拉起作业、会话启动补偿)。与真实清单 loader(`loadHostExtensions`)的结构契约兼容有集成测试。
3. **作业体引擎循环**(`src/evolve/jobRun.ts`,`jobMain` 调用):可选源探测 → 信号合并(自上次作业结束)→ runChecks 发现 → rule-based 提案 → 机械校验 → L1 前闸 → 风险分类 → 采纳门(A 仅 auto-A 且闸通过自动采纳并通知)→ pending 呈现/自动采纳 → 应用阶段(全部已批准编辑同一备份会话 + 按 delivery 分类对原生渲染 agent 触发同步)→ lesson(记忆启用走记忆管道,否则只留档案)。fixture E2E 的同链流水现由生产入口承载。

接线后仍要知晓的边界(如实记录,不是缺口):

- **editor/spawn 提案通道未接**:`runDelegatedCall` 就绪前作业只走 rule-based 兜底(design D7 的降级路径);harness2 引擎的 proposer spawn 面在引擎包内已移植并 golden 锚定,生产接入随 L2/探针任务集一并启动。
- **发现面=观察面**:作业只扫描信号层归属出现过、或级别策略声明过的 workspace;没进过观察面的 workspace 不会被发现(与"信号是观察记录"一致)。
- **批准后降级的边界**:`propose` 下批准、随后整机降回 `observe` 时,应用阶段暂停到下次 propose+ 作业(`observe` 只采集);`trellis evolve status` 可见 approved 计数。
- **生效侧判定**:`triggerRenderSync` 只在存在原生渲染 agent 且本次有编辑被应用时触发一次;`isMemoryDeliveryEnabled` 按 memory MCP server 的显式配置(`staticEnv.MEMORY_FILE_PATH`)判定记忆管道开关。
- **agent 粒度只闸观察与触发**:提案产出按提案目标层粒度(workspace > default)判定——发现来自 doctor 检查面,不归属某个 agent 的行为;只设 `agents: {x: propose}` 时作业会被拉起但不产提案(spec 已就此澄清)。
- **agent 接口面 transport 后置**:`agentView.listPendingSummaries` 与 `reportUserCorrection` 函数与约束(只读、无批准能力、secrets 擦除)已交付并有测试,但本期不进 MCP/CLI/provider——真实会话中的 agent 尚无可达通道,接入随 editor/spawn 通道一并启动。
- **`secrets-policy-fix` 的 Class A 归属待 editor 通道接通时复审**:当前 rule-based 通道只产 workspace-toml 修复(恒 B),该规则不可达;接通 editor 通道前评估是否降为 B。

## 可视化(2026-10-27,trellis-evolve-visualization)

进化过程对用户可见的三段呈现(只读消费,查看零副作用):

- **数据出口**:`trellis evolve report [--json]` 与 `status --json` —— 单一聚合函数 `src/evolve/reportView.ts`(`buildEvolveReport`)从档案/pending/级别策略计算,CLI 文本、JSON、GUI 三副渲染壳同源,不维护第二份计算。
- **GUI 仪表盘**(`packages/gui` Evolution 页):趋势(真实测量,含口径)、优化内容卡(前后 finding 差集 + 编辑清单)、提案时间线(发现→提案→verdict→决策→应用→lesson 全链,含备份会话回滚入口)。
- **指标诚实性原则**(spec 约束):只展示可从档案重算的真实测量(累计发现解决数、采纳率/拒绝率、作业运行/失败次数);**不合成数值评分**,分数轴等 L2 探针任务集落地后另起变更。空态/未开启是一等状态,不画误导性的空图。

## 审查修复轮(2026-10-26,子 Agent 四路审查后)

阶段一收口后做了一轮四路只读审查(spec 符合性/正确性/安全/测试覆盖),随后修复:

- **崩溃循环链**:spawn 失败收容(`error` 监听,pid 缺失记 `spawn-failed` 而非假 launch);作业体抛错也落 job-run 档案(endedAtMs 推进冷却,error 留审计,不再无限重拉);apply 部分失败落 failed 标记档案且 `remove-symlink` 幂等重放。
- **信号水位线**:job-run 档案记"信号合并时刻"(signalsMergedAtMs),触发计数与作业合并以它为界——作业运行期间到达的信号不再永久丢失。
- **staging 凭据排除**:`.trellis` 复制剔除 `mcp/oauth`、`backups`、`evolve`(`TRELLIS_STAGING_EXCLUDES`),凭据不离开真实 home。
- **纵深防御**:应用阶段对每条 approved 记录重跑机械校验(`validateProposal`),pending 磁盘漂移/伪造编辑到不了写入面;死锁清理改 compare-and-delete。
- **写路径加固**:`evolve.yaml`/`extensions.yaml`/pending 记录全部原子写(tmp+rename);进化状态目录 0700、信号/档案/pending 文件 0600;`extensions` 键非数组硬抛而非静默吞;`enable` 建状态目录骨架并在 dotfiles 仓库场景把 `evolve/` 加入 .gitignore。
- **自治升级门**:`enable --level propose|auto-A` 与 approve 同级 TTY 闸门(非交互 agent 会话不得自行提升自治级别);`disable` 不再接受 `--level`,存在非 off 覆盖时明确提示仍生效。
- **spec 措辞对齐**:触发判定去掉"严重度"(本期按计数);补充 agent 粒度语义;`trellis evolve status` 展示最近自动采纳通知(原只落档案)。

## 下一步

1. **`auto-A` 准入评估**:带外批准强度(见 design Risks)、需要多少次有人监督的运行才算"证明不误报"(待决);此后才谈真实开启 `auto-A`。
2. **L2 与探针任务集**(来源与归属待决)、lesson 回流提质(全局记忆启用后才有真实载体)、editor/spawn 提案通道接入(等 `runDelegatedCall`)。
3. **阶段二**:引擎提升公开 npm 包 = agent-framework 整合(同一动作),等第二个真实消费者;递归预算、容器化 probe 为后续独立变更。
