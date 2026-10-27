# Tasks

> 顺序即依赖(2026-10-24 按"移植引擎"方向重组):第 1 组 golden 基线先于一切 TS 代码;第 2–7 组(引擎移植,阶段一内部包)与第 8 组(托管扩展点)互不依赖、可并行;第 9 组(适配层)依赖两者;第 10–14 组在其上逐级交付。原第 1 组的三项只读前置验证:扩展加载机制与状态目录路径移至 8.1(8.6 的实现依赖该决定,须先于组 8 实现项完成),其余两项移至 9.4。

## 1. 移植前置:golden 基线(移植正确性的锚)

- [x] 1.1 在隔离 fixture 目录跑通 Python 原版 harness2 的最小路径(fake benchmark 上的 sweep/单元流),记录可复现的输入→输出对照集(树编辑结果、judge 判定、ledger 记账、report 输出);验证:对照集可重复运行且结果稳定,连同运行方式存入引擎包 `golden/` 文档。
- [x] 1.2 定案 prompt 模板语言(默认:原样保留英文);验证:结论写入 design 的 Open Questions;如改中文化,1.1 对照集须重建。

## 2. 阶段一落点:workspace 内部包骨架(不发 npm)

- [x] 2.1 建 `packages/evolve-engine/`:TS 工程骨架、runtime 零第三方依赖约束(仅 devDependencies)、Apache-2.0 attribution/NOTICE 注明衍生自 google-research/harness2;验证:依赖审计脚本证明 runtime deps 为空;包内无任何 Trellis import 的边界测试通过。
- [x] 2.2 原样翻译 `Substrate` 协议(5 方法 + `Install`/`RunRequest`/`Launcher` 类型,83 行);验证:与 Python `substrate/base.py` 逐字段对照清单审查通过;frozen dataclass → readonly 类型的不可变语义编译验证。

## 3. 引擎移植·基础层(tree → runmark → ledger → judge)

- [x] 3.1 移植 `tree`(frozen dataclass → readonly + freeze)、`runmark`(指纹缓存键)、`ledger`(预算恒等式);验证:golden 对照集对应条目全绿(同输入比输出)。
- [x] 3.2 移植 `judge` 的 None 语义(评分失败 = None,不计入分母、永不记 0);验证:judge 失败路径的单元测试。

## 4. 引擎移植·声明与中间层(spec → prompts → context → library)

- [x] 4.1 移植 `spec` 与 `prompts`(模板原样保留英文;正则逐条核对 Python 方言差异);验证:提取正则的 fixture 测试与 Python 行为一致。
- [x] 4.2 移植 `context`(穷人沙盒:`fs.mkdtemp` + `fs.cp` 对应 mkdtemp/copytree,harvest 收割子路径,超时需显式 setTimeout + kill)与 `library`;验证:沙盒语义测试(每次调用独立临时目录、失败清理、harvest 子路径完整、超时进程确实被杀);golden 对照全绿。

## 5. 引擎移植·核心层(proposer → selection)

- [x] 5.1 移植 `proposer`:调用指纹缓存、重试退避 `10s×(attempt-1)`、`BoundedSemaphore` → TS 信号量、失败收口 `Reply(ok=false)`、审计写盘;验证:golden 对照全绿;缓存命中零子进程的测试;并发不超闸的测试。
- [x] 5.2 移植 `selection`:两段式物理隔离(选择器不可见评分材料、无 verdict 字样、不标明哪臂为新);验证:隔离结构测试;golden 对照全绿。

## 6. 引擎移植·编排层(schedule → recursion → report)

- [x] 6.1 移植 `schedule`(循环与预算终止)、`recursion`(胜者写回 base / 失败回滚)、`report`;`ThreadPoolExecutor` → Promise 并发池,`as_completed` 聚合顺序显式化;验证:golden 对照全绿;单会话失败不拖垮整轮 sweep 的测试。

## 7. 凭据与执行适配(三处显式偏差中的两处在此落地)

- [x] 7.1 凭据注入:不移植任何 Vertex env(`CLAUDE_CODE_USE_VERTEX`/`GOOGLE_VERTEX_*` 等),spawn 本机 CLI + 现有凭据形态(agent-bridge 或本机登录态);验证:spawn env 快照测试证明不含任何 `GOOGLE_*`/`VERTEX_*` 变量;凭据缺席时 preflight 报错并给出修复指引。
- [x] 7.2 无绕过断言:引擎 spawn 规格不含任何审批/沙盒绕过标志(harness2 的 `--dangerously-bypass-approvals-and-sandbox` 不采纳);验证:含"无绕过标志"断言的单元测试(映射 self-evolution spec 的 probe 隔离要求)。

## 8. 托管扩展点(`host-extension-points`,不含任何进化字样;与第 3–7 组并行)

- [x] 8.1 只读决策,先于本组实现项:定案扩展加载机制(须同时覆盖事件订阅者的装载路径——recorder 是订阅者不是 provider,在"托管不依赖进化"约束下明确 gateway 启动时由谁、按什么约定加载它)与状态目录路径;验证:design.md 对应 Open Questions 更新为已决定,`host-extension-points` spec 与之一致。
- [x] 8.2 定义事件类型(工具调用事件、会话开始/结束事件),字段白名单在类型层强制、不含入参/结果字段;"会话开始"事件含进程观察到的 workspace root(信号层归属的派生来源);验证:类型测试证明事件对象上不存在载荷字段,且序列化后不含构造时放入入参的凭据形态字符串。
- [x] 8.3 实现事件总线(进程内、同步发出、订阅者异常被吞并警告、无订阅者零开销),在 `BuiltinRegistry.callTool` 咽喉点与 `waitForShutdown` 关闭路径挂载,启动后发"会话开始";验证:单元测试覆盖上游与内建调用都产生事件、订阅者抛异常不影响调用结果、无订阅者时行为与引入前一致、会话标识在同一进程内一致。
- [x] 8.4 关闭路径在释放上游之前发"会话结束";验证:测试覆盖 stdin 关闭与 SIGTERM 触发结束事件;并显式记录"SIGKILL 不保证结束事件"的测试说明。
- [x] 8.5 实现 `src/host/` 窄门面并在 `package.json` 增加 `./host` 导出:读表面、staging、结构化检查(带稳定标识与层归属)、备份会话内应用、回滚;验证:导出面测试证明不含 `src/adapters/*`、`src/commands/*` 符号,且根入口导出与此前一致;集成测试证明多编辑应用后回滚逐字节还原、staging 后真实 canonical 不变。
- [x] 8.6 按 8.1 定案的加载机制(扩展清单 + `activate` 契约,provider 与订阅者同面)实现外部扩展注册与故障隔离;验证:声明两个扩展、其一加载失败时另一个与核心 provider 照常工作且失败被报告;无扩展时工具列表与此前一致。
- [x] 8.7 添加"托管不依赖消费者"的构建级测试(把进化各部分移出构建后托管的构建与测试结果不变);验证:该测试在 CI 中运行并通过。

## 9. TrellisSubstrate 适配层(依赖第 2–8 组)

- [x] 9.1 实现 `surface()`:声明 Trellis 可编辑树 schema(agents.md 段落、skill 条目、MCP 路由、memory 策略;含静默失效模式),Class C 目标不在 schema 内(引擎根本看不到不可编辑面);验证:schema 拒绝面测试(受保护目标不可达)+ 不可变语义测试。
- [x] 9.2 实现 `materialise()`(经 `host` 门面做 staging 渲染)与 `preflight()`(doctor 级自检,失败抛错带修复命令,不启动任何模型链);验证:staging 后真实 canonical 逐字节不变;preflight 故障注入测试。
- [x] 9.3 实现 `execute()`(穷人沙盒内拉起探针会话,每 run_id 一个 run_dir)与 `read_trajectory()`(会话记录/轨迹渲染为共享语法);验证:轨迹渲染 golden fixture;探针工作区不含工作区之外的用户数据。
- [x] 9.4 前置验证两项(只读):① 真机采样元数据事件能产生什么信号(决定 `observe` 采集字段);② 核实 skills/instructions provider 读取路径(会话快照 Open Question);验证:design.md 对应 Open Questions 更新为已决定。(扩展加载机制与状态目录路径已在 8.1 定案)

## 10. 进化地基与分级开启(`self-evolution`)

- [x] 10.1 定义核心类型(Signal、Proposal、Verdict、Lesson、RiskClass、Level),`layer` 字段贯穿所有类型;验证:序列化 fixture 测试证明层归属在完整往返后保留。
- [x] 10.2 实现分级开启:四级、全局/agent/workspace 三个粒度、更具体覆盖更宽泛、显式写入 canonical、`trellis doctor` 输出各 agent 级别;验证:三个 spec 场景(默认关闭零副作用、更具体覆盖、doctor 可见)。
- [x] 10.3 实现边界测试:`src/evolve/` 只 import 引擎包与 `src/host/*`;验证:引入一条越界 import 的反例,测试失败。
- [x] 10.4 实现运行档案与状态目录(与 canonical 分离、只追加记录写入器;路径按 8.1 的决定,并加入 `.gitignore` 如适用);验证:档案往返测试。

## 11. Observe 与触发(环境式接入)

- [x] 11.1 实现 gateway 进程内 recorder:订阅事件、字段白名单、secrets 擦除、按进程分文件追加;验证:载荷不入库、并发两会话互不阻塞且不丢信号、`off` 时不写入任何记录。
- [x] 11.2 实现 agent 可调用的上报入口(用户纠正),文本经擦除、带层归属;验证:调用后产生 kind 为 `user-correction` 的信号且文本已擦除。
- [x] 11.3 evolver 自身活动不进信号(防自激)与可选信号源(agent-bridge 委托记录)缺席处理;验证:作业运行期间的调用/编辑不产生信号;无委托存储时运行继续并记 unavailable。
- [x] 11.4 doctor 输出明确列出"哪些 agent 有事件观察、哪些只有 doctor/sync 信号";验证:fixture 含 runtime 与仅原生渲染两类 agent 时输出区分正确。
- [x] 11.5 实现会话结束时的阈值/冷却/预算判断与一次性 detached 作业拉起(作业即运行移植引擎),单实例锁;验证:满足条件拉起一次且结束后无残留进程;作业运行中再次满足条件不启动第二个;超出每日提案上限时跳过并记录原因。
- [x] 11.6 实现会话启动时的补偿评估;验证:模拟上一会话被强杀(无结束事件)后,下次启动仍会评估累计信号并按阈值决定。

## 12. L4 治理层(harness2 没有的 Trellis 增量)

- [x] 12.1 实现 L1 doctor-oracle 前闸:对 baseline 与 staging 候选运行 {doctor findings、`sync --check`、secrets audit} 并计算 verdict 差集,在 L1 适用域(配置类 kind 白名单)内作为**唯一 verdict**(配置类提案不运行引擎评分链);同时承担提案类域分派:仅 kind 白名单内的配置类提案进入提案通道,内容类提案本期不产出(等 L2 选择器执行);条目带层归属,staging 复现层分裂;任何意外错误按"不采纳"收口,测量失败记 unknown;验证:命中修复可采纳、引入回归不可采纳、被 workspace tombstone 的全局编辑不影响该 workspace 的 verdict、强制报错收口四个场景。
- [x] 12.2 实现证据要求与机械校验(kind/target 白名单、层检查、workspace 可提交约束、不自动升格标记,至多一次带反馈重试,反馈接引擎 `validate_tree` 通道);委派/spawn 不可用时对 doctor finding 形态信号走 rule-based 提案;验证:覆盖 `no-evidence`、auth 目标拒绝、进化自身配置拒绝、跨层拒绝、凭据字面值拒绝、不自动升格全部场景 + 委派禁用时的 fallback 测试。
- [x] 12.3 实现风险分类器(数据驱动:kind + target → A/B,未知 → B,仅单 workspace 证据支撑的全局升格 → 一律 B,C 已在校验阶段拒绝)与采纳门(A 仅 `auto-A` 且通过;B 永远需批准);验证:分类表测试 + 四个过门场景(自动采纳并通知 / 低于 auto-A 不自动 / 无法分类按 B / auto-A 下升格编辑仍按 B 不自动采纳)。
- [x] 12.4 实现 pending 提案存储与 agent 只读接口(列出摘要/证据/风险级别,无凭据、无批准/应用操作),管理面命令 `status | pending | approve | reject | enable | disable | rollback`(批准仅限交互式终端),命令不触发循环;验证:agent 可见接口无变更类操作;非交互环境批准被拒且提案保持 pending;运行 status 不产生任何信号或作业。
- [x] 12.5 实现应用与生效:全部已批准编辑在同一备份会话内写入并记录会话标识;采纳后原生渲染 agent 触发同步、runtime agent 说明生效时点;验证:三条编辑经标准回滚逐字节还原;runtime agent 新会话读到新版本且无需同步。
- [x] 12.6 实现 lesson 记录(cue / 正文 / 证据 / 可选 confidence / 层作用域),记忆启用时走现有记忆管道、未启用时只留档案;后续提案只呈现匹配上下文的 lesson;验证:两种记忆状态的测试(未启用报 skipped 而非 failed)+ 仓库 X 的 lesson 不原样进入仓库 Y 的提案上下文。

## 13. L2 协议与 base 留池偏差(第三处显式偏差)

- [x] 13.1 定义 L2 比较记录格式(匿名臂、种子标识映射、选择器结果、失败收口的 verdict)为类型与档案写入器;验证:序列化 fixture 测试。
- [x] 13.2 实现 base 留池偏差(引擎侧最小补丁,见 design D11 落点说明):`BenchSpec`/surface 声明 `keepBaseInPool` 数据开关,schedule 据此把 base rollouts 并入候选池——源码核实 base 排除发生在 `schedule` 调 `selection_pool` 处,适配层无法覆盖;补丁集中于池构造,引擎其余逻辑不动;验证:含 base 的比较测试;选中 base ⟹ 不采纳;选择器失败回退 base(`_fallback`)与留池语义不冲突的测试。
- [x] 13.3 实现 probe 工作区隔离 helper(mkdtemp 工作区、staging 渲染配置、重定向 agent 配置 HOME,断言无绕过标志);验证:含"无绕过标志"断言的单元测试。本组不实现选择器执行(等探针任务集)。

## 14. 端到端与验收

- [x] 14.1 fixture 机器端到端:植入 `workspace-toml-invalid` → 信号 → 引擎循环 → workspace 层提案 → L1 前闸可采纳 → Class B 呈现、带外批准 → 单会话写入 → lesson → 全局层逐字节不变;验证:集成测试断言每类档案记录存在。
- [x] 14.2 `npm run test` 与 typecheck 全绿;每条 spec 场景至少映射到一个测试(映射表写进 PR 描述);第 3–6 组的 golden 对照集全部通过。
- [x] 14.3 `openspec validate trellis-evolve --strict` 通过;真机冒烟:默认 `off` 状态下运行 agent 会话后 `~/.trellis` 与状态目录均无变化(`git status` 与目录比对确认)。
- [x] 14.4 更新 `docs/self-evolution.md` 的状态与已核实表、`docs/roadmap.md`;确认阶段二启动条件未满足前 `packages/evolve-engine` 不进任何 npm 发布配置。
