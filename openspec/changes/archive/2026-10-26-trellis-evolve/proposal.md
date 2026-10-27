# Proposal

> **状态:方向已修订(2026-10-24),未实现。** 接手请先读 [`docs/self-evolution.md`](../../../docs/self-evolution.md) 的"接手指南"。本 change 是该文档的**可验证契约版**:想法与取舍在文档里,行为约束在 `specs/` 里,二者冲突时以 `specs/` 为准。**修订内容**:进化核心改为移植 harness2 引擎(TS),行为契约(specs)不变,机制由移植引擎承载。

## Why

Trellis 已托管 skills、MCP、指令、scope、memory,但托管内容的**改进完全靠人**:doctor 发现的问题要人修,用户纠正过的错误没有机制沉淀,skill 写好后就静止。2026-10 的两个真实事故(workspace `.codex/config.toml` 重复键让该项目所有 Codex 会话静默失败约 19 小时;PATH 上 0.12.0 旧入口遮蔽 0.16.0 导致误诊)说明信号一直存在,缺的是把"信号 → 提案 → 验证 → 采纳 → 教训沉淀"闭环起来的机制。

方向已明确:Trellis 由**两个解耦的子系统**组成——**托管**(让配置被正确投递并保持一致)和**自我进化**(让被托管的内容随使用变好)。进化是挂在 runtime 底座上的**环境式能力**,跑在其上的 agent 自己持续进化,可选安装、分级开启;它**不是**一条要用户去敲的命令。依赖方向只有一条:进化 → 托管,绝不反向。

harness2(google-research)提供了经验证的引擎(Propose–Probe–Compose、两段式测量、失败收口、指纹缓存、穷人沙盒)。**2026-10-24 方向修订:不做自设形态,直接把引擎移植为 TypeScript**——调研证实其 core 零第三方依赖、无平台门控、Vertex 仅是 spawn 子进程的环境变量,core ≈5,650 行可整体直译(Apache-2.0 允许;无 PyPI 包、无公开 API 意味着移植只能由我们完成)。打包分两阶段:阶段一为 workspace 内部包,不发 npm;阶段二等第二个消费者(如 agent-framework)出现时提升为公开包。Trellis 已具备大部分地基(doctor 作 oracle、backup/rollback、memory 管道、workspace 层、agent-bridge),缺的是托管侧几个**通用**扩展点与引擎的宿主适配层。

## What Changes

**A. 托管侧:通用扩展点(先做,不含任何进化字样)**
- gateway 路由层对每次工具调用发出**仅含元数据**的事件(不含入参/结果);会话开始/结束发出生命周期事件;无订阅者时零行为变化。
- 新增 `agent-trellis/host` 子路径:公开写入(带备份会话)、回滚、机器可读检查、staging 的**窄门面**,不放开 `src/adapters/*`、`src/commands/*` 内部。
- 约定外部扩展向 gateway 注册 provider 的方式,单个扩展加载失败不影响核心与其他扩展。

**B. 进化侧:可选安装的独立子系统**
- **进化核心是移植的 harness2 引擎**(`packages/evolve-engine/`,阶段一内部包):引擎只依赖 `Substrate` 协议(5 方法,原样翻译),对 Trellis 零感知。适配层依赖托管的 `host` 子路径与事件,不 import 其他内部;卸载后托管行为逐字节不变。
- **环境式运行**:被动观察(元数据)+ agent 主动上报纠正 → 会话结束(及下次启动补偿)按阈值拉起**一次性**后台作业(无常驻进程)→ 移植引擎的循环(提案–验证–采纳,机制由引擎承载)→ 提案进入 pending → **带外批准** → 单备份会话写入 → 下个会话自然读到新版本 = 生效。
- **分级开启**:`off`(默认)→ `observe` → `propose` → `auto-A`;粒度全局默认 + per-agent + per-workspace;显式选择、写进 canonical、doctor 可见。
- **评测分层**:L1 配置类 = doctor / `sync --check` / secrets audit 的确定性 verdict 差集(零 LLM);L2 内容类 = 沙盒执行 + 匿名 A/B(base 留在候选池里,失败一律倒向不采纳),本期只交付协议与边界脚手架;L3 = 带 checklist 的成绩单(后置)。
- **风险分级**:Class A(可逆零半径)仅 `auto-A` 且 probe 通过时自动采纳;Class B(内容/路由)永远人批,**批准只走带外通道**;Class C(secrets、auth、受管集合、用户手写文件、进化自身配置)连提案都不生成。
- **层级隔离**:全部数据带 `global | workspace(<root>)` 归属;跨层写入拒绝;单项目证据不自动升格全局;workspace 编辑继承可提交约束。
- CLI 退居管理面:`status | pending | approve | reject | enable | disable | rollback`,不触发进化循环。
- 完整运行档案 `evolve` 状态目录、lesson 回流 `memories/`、失败一律收口。

## Capabilities

### New Capabilities

- `host-extension-points`: 托管侧的通用扩展点——元数据事件流、会话生命周期事件、`host` 子路径窄门面、外部扩展(provider 与事件订阅者)注册与故障隔离、单向依赖保证。
- `self-evolution`: 可选安装的自我进化子系统——分级开启、环境式观察与触发、证据背书提案、L1 确定性验证与 L2 协议、风险分级与带外批准、层级隔离、单会话写入与回滚、lesson 回流、probe 隔离。

### Modified Capabilities

(无。`trellis-sdk` 的"根入口不得导出 adapters/commands 内部"约束保持不变——`host` 是独立子路径上的新门面,根入口不动。doctor、backup、memory、agent-bridge 作为依赖被复用,其行为不变。)

## Impact

- **托管侧改动点(已核实位置)**:`src/lib/mcpRuntime.ts`(`BuiltinRegistry.callTool` 约 :77 与 `createRuntimeServer` 的 `tools/call` handler 约 :236)、`src/commands/mcpGateway.ts`(`waitForShutdown` 约 :200)、新增 `src/host/`、`package.json` 的 `exports` 增加 `./host`。
- **进化侧新代码**:`packages/evolve-engine/`(移植的引擎,阶段一内部包、不发 npm;引擎对 Trellis 零依赖)与 `src/evolve/`(适配与治理层,受边界测试约束只允许 import 引擎包与 `src/host/*`)。阶段二(公开包)待第二个消费者出现再启动,届时与 agent-framework 整合是同一动作。
- **依赖的现有资产(只读复用)**:`src/lib/backup.ts` 的 `openBackupSession`、`collectDoctorReport`、secrets audit、memory 管道、workspace 层与逐条目层归属、agent-bridge `runDelegatedCall`。
- **覆盖范围的诚实边界**:事件只来自经 gateway/runtime 投递的 agent;仅走原生渲染的 agent 没有工具调用事件,只能获得 doctor / sync 类信号。
- **前置条件**:agent-bridge 尚有 5 个未完成项(editor 委派依赖其 `runDelegatedCall`,不可用时 L1 降级为 rule-based 提案);全局记忆需启用才有 lesson 回流的真实载体;L2 需探针任务集。
- **明确不做**:进化 Trellis 自身代码、secrets、auth、受管集合、用户手写文件;让托管依赖进化;绕过目标 agent 的审批/沙盒(harness2 宿主机 bypass 的做法不采纳);在没有现成 oracle 的类别上抢跑自动采纳。
