# Design

## Context

动机见 proposal.md - Why;想法、取舍与路线见 `docs/self-evolution.md`。**2026-10-24 方向修订**:不再自设形态,把 harness2 引擎(`~/www/morphix-research/sources/harness2`,已对照源码核实:core 零第三方依赖、无平台门控、Vertex 仅是 spawn 子进程的环境变量)整体移植为 TypeScript;本设计描述移植落点、宿主适配与治理层。

**已核实的现状(2026-10-20,读代码所得)**

| 事实 | 位置 | 对设计的影响 |
|---|---|---|
| 所有工具调用(内建 provider 与上游 MCP)汇入同一个咽喉点 | `src/lib/mcpRuntime.ts` `BuiltinRegistry.callTool`(约 :77),由 `createRuntimeServer` 的 `tools/call` handler(约 :236)调用 | 元数据事件可在此一处挂载,无需改各 provider |
| `RuntimeContext` 只有 `{ agentId, homeDir }`,没有会话标识,也没有 workspace root | `mcpRuntime.ts:14` | 会话标识须由事件层在进程启动时生成;层归属(global vs workspace root)在事件里无来源,须由"会话开始"事件携带进程观察到的 workspace root 补齐 |
| 关闭路径只处理 stdin `end`/`close` 与 SIGTERM/SIGINT/SIGHUP,随后 `registry.close()` 逐个调用 `provider.close()` | `src/commands/mcpGateway.ts` `waitForShutdown`(约 :200) | 正常退出可发"会话结束";**SIGKILL/崩溃不覆盖**,须有下次启动的补偿检查 |
| gateway 按会话拉起、client 断开即释放,规范明确无常驻进程 | `mcp-gateway-hosting` spec | 进化不能引入 daemon,只能事件驱动的一次性作业 |
| `openBackupSession(homeDir, command)` 已存在但**未经 SDK 公开** | `src/lib/backup.ts:117` | `host` 门面需包装它,而不是让进化 import 内部 |
| `collectDoctorReport` 已导出但在 `commands/doctor.ts`,不在 SDK | `src/commands/doctor.ts:176` | 同上;门面返回结构化、带层归属的结果 |
| SDK 根入口只导出 `loadCanonicalSource`、`ALL_AGENTS`、`resolveScope` 与类型,且 spec 禁止导出 adapters/commands 内部 | `src/sdk.ts`、`trellis-sdk` spec | `host` 做成**独立子路径**,根入口不动 |

**覆盖范围的诚实边界**:事件只来自经 gateway/runtime 投递的 agent。仅走原生渲染的 agent 没有工具调用事件,只能获得 doctor / sync 类信号。

**harness2 的要点(决定了评测与失败语义)**:选择与评分物理分离(`core/selection.py`、`judge.py`);judge 失败 = `None` 不是 0,选择器失败回退 base;`runmark.py` 用 harness 树 sha1 指纹守卫复用;框架差异是数据(`SurfaceSpec`)而不是分支;本机执行用"穷人沙盒"(临时 workspace + 隔离配置 HOME + 一次性会话),容器只留给重 benchmark。

## Goals / Non-Goals

**Goals:**

- 托管与进化解耦:依赖只朝一个方向,进化可独立测试(fake host)、可整体卸载。
- 进化是环境式、可选、分级的能力,不引入常驻进程,不新增触发命令。
- L1 配置类端到端可用;L2 只交付协议与边界;每次写入有证据、先验证、可单点回滚。
- 全局层与 workspace 层在每一环都不混淆。

**Non-Goals:**

- 进化 Trellis 自身代码,或任何 Class C 目标。
- 托管层对进化的任何认知或依赖。
- 探针任务集、K 候选递归预算、容器化 probe、Class B 的自动采纳(P4/P5)。
- 绕过目标 agent 的审批/沙盒机制。

## Decisions

### D1: 一个 change、两个 capability;代码三处布局,边界测试强制

`host-extension-points`(通用)与 `self-evolution`(消费者)在同一 change 内交付。代码分三处:`packages/evolve-engine/`(移植的引擎)、`src/evolve/`(适配与治理)、`src/host/`(托管扩展点)。边界以测试强制:`evolve-engine` 不 import 任何 Trellis 代码(引擎宿主无关,只依赖 Substrate 协议);`src/evolve/` 只允许 import 引擎包与 `src/host/*`;把任一进化部分整体移出构建后,托管的构建与测试结果不变。**理由**:单个 change 便于接手与排序,解耦是代码边界而不是 change 边界;引擎独立成包使 golden 对照与将来的公开化(阶段二)不需要动宿主。**替代**:引擎直接写进 `src/evolve/`——否决,那会把"宿主无关的引擎"与"宿主适配"重新搅在一起。

### D2: 引擎侧协议 = harness2 `Substrate` 原样翻译;`host` 门面服务适配层

(2026-10-24 修订,原 `HostPort` 草案作废。)引擎只认识 `Substrate` 协议的 5 个方法——`surface / materialise / execute / read_trajectory / preflight`,83 行 interface 从 harness2 原样翻译,不自造接口。`src/evolve/` 的 TrellisSubstrate 实现该协议:`surface` 声明 Trellis 的可编辑树 schema(哪些能改、静默失效模式——`SurfaceSpec` 思想在此落地),`materialise` = staging 渲染,`execute` = 探针会话执行,`read_trajectory` = 会话记录/轨迹渲染为共享语法,`preflight` = doctor 级花钱前自检;其内部经 `host` 门面与事件机制接入托管。**理由**:协议是 harness2 已验证的签名,减少移植偏差;引擎可用 fake substrate 独立测试;换宿主只重写适配层。托管的 `scope.yaml`(怎么渲染)仍属于托管,不并入树 schema。

### D3: 事件是进程内、同步发出、失败开放

事件总线在 gateway 进程内,发出点在咽喉点与关闭路径。订阅者调用被 try/catch 包住,慢订阅者不得阻塞调用路径(订阅者自己负责异步落盘)。字段白名单在**发出端**强制,而不是靠订阅者自觉:事件类型里根本没有入参/结果字段。**理由**:隐私与"对调用路径透明"都应由托管保证,否则每个订阅者都得重新证明一遍。

### D4: 进化在 gateway 进程内只有一个轻量 recorder

gateway 进程内加载的进化部分只做一件事:订阅事件、过白名单与 secrets 擦除、追加写入信号。所有重活(提案、probe、委派)都在 detached 的一次性作业里。**理由**:gateway 是用户 agent 的热路径,必须保持轻;作业崩溃不应波及会话。

### D5: 信号存储按进程分文件、只追加

每个 gateway 进程写自己的信号文件(文件名含 agent 与会话标识),作业读取时合并。**理由**:免去跨进程锁;多 agent 多会话并发天然安全。存放位置与 canonical 分离(沿用 OAuth 凭据"存于 canonical 之外"的做法),具体路径见 Open Questions。

### D6: 触发 = 会话结束判断 + 下次启动补偿

会话结束事件上评估阈值并拉起一次性作业;因为 SIGKILL/崩溃不发结束事件,**每次会话启动时再做一次补偿评估**。单实例靠作业锁文件;预算(editor 调用、冷却期、每日提案上限)超限即跳过不排队。**理由**:同时满足"无常驻进程"和"不漏触发"。**替代**:外部调度器(cron/launchd)——否决,依赖用户机器配置且违背现有原则。

### D7: 提案会话由引擎 proposer 拉起;输出按不可信处理

(2026-10-24 修订。)improver/editor 与 judge 会话由引擎 `proposer` 以 spawn CLI 子进程产生(harness2 原机制),凭据以环境变量注入本机形态——**三处显式偏差之一**:不移植任何 Vertex env。`validate_tree` 的"校验错误即 prompt 喂回重试一次,再错丢弃"由引擎承载。风险分级、目标合法性与 Class C 硬排除由 L4 治理层代码计算,目标排除同时写进 `surface()` 的树 schema(引擎根本看不到不可编辑面),不采信模型自报。agent-bridge `runDelegatedCall` 保留为可选委派通道;不可用时 proposer 直接 spawn 本机 CLI,doctor finding 形态的信号走 rule-based 提案(例如 `workspace-toml-invalid` 有显而易见的机械修复)。

### D8: L1 verdict 差集是对结构化检查的集合运算

V0 = 对真实 canonical 的 {doctor findings, `sync --check`, secrets audit};V1 = 对 staging 副本的同样检查。可采纳 ⟺ (无新条目) ∧ (目标条目被消除) ∧ (其余不变)。条目带稳定标识与层归属。**理由**:配置类的检查本身就是 ground truth,比 LLM 选择器更强也更便宜;两个起因事故都属此类。**定位(2026-10-24 修订)**:在 L1 适用域(配置类)内,它是**唯一的 verdict**——配置类提案没有 benchmark 任务可评分,引擎评分链不运行,不是"前置验收器后还有 judge"。**本期范围**:只对 L1 适用域(配置类 kind 白名单)产出提案;内容类提案本期不产出,等 L2 选择器执行落地(见 Non-Goals 与 spec 的 L2 记录协议)。L1 适用域的判定由 L4 治理层按 kind 白名单执行。

### D9: 风险分级是数据;批准走带外通道

分级由代码按 kind + target 计算:A 可逆零半径、B 内容/路由、C 受保护(校验阶段拒绝)、无法分类 → B。批准通道**不暴露给 agent**:agent 侧接口只有读 pending 与上报纠正;批准只能经管理面命令在交互式终端完成。**理由**:被进化者不能批准自己的进化;若暴露带 `confirm=true` 的工具,批准形同虚设。**已知局限**:有 shell 能力的 agent 理论上可以执行管理面命令,TTY 检测只是启发式防线(见 Risks)。

### D10: 层级感知贯穿全链路

`layer`(`global` | `workspace(<root>)`)贯穿 Signal → Proposal → Verdict → Lesson。规则:目标校验带层检查;单项目证据不自动升格全局;workspace 编辑继承可提交约束且视为对外副作用;staging 复现层分裂(scratch 全局 HOME + 临时 workspace root,按 `workspace-scope` 合并、tombstone 生效)。**理由**:起因事故的文件是 git 跟踪在团队仓里的,"在全局层修它"会错两次。

### D11: L2 协议——base 留在池里、匿名、失败收口

同一探针任务在 baseline 与候选下各跑一次,交付物冻结后以种子匿名标识呈现给独立选择器(无 verdict、无评分字样、不标明哪臂是新)。选择器失败 / 任一臂未交付 / 选中 base ⟹ 不采纳;选中候选 ⟹ 仅进入风险分级门。**一处刻意反转**:harness2 把 base 排除出候选池(构造上无法弃权,因为它必须进化);我们保留 base,因为我们不能退化。这是对"原样移植"的三处**显式、有界偏差**之一。**落点(2026-10-24 源码核实后修订)**:base 排除发生在引擎编排层而非适配层——`schedule` 调 `selection.selection_pool(mode, k, rollouts, base)` 时 base rollouts 与候选分开传递,`selection.py` docstring 明说 "base is what the pool excludes";适配层拿不到这个开关。因此做法是引擎侧一处最小补丁:`BenchSpec`/surface 声明 `keepBaseInPool` 数据开关,schedule 据此把 base rollouts 并入候选池,补丁集中于池构造,引擎其余逻辑不动;同时保证与选择器失败回退 base(`selection.py` 的 `_fallback`)语义不冲突(另两处显式偏差:凭据 env 形态见 D7、不使用审批/沙盒 bypass 标志见 D12)。本期只交付协议、记录格式与边界。

### D12: probe 工作区——穷人沙盒,容器后置

`mkdtemp` 工作区 + staging 渲染配置 + 重定向的 agent 配置 HOME + 一次性会话;**不使用任何沙盒/审批绕过标志**。沙盒保证每次执行干净可复现,对比本身发生在冻结的产物上而不在沙盒里。容器(本机有 OrbStack)推迟到探针要跑不可信代码或需要并行 K 候选时。

### D13: 缓存身份 = 被测切片的内容摘要

缓存键为编辑触及的确切 canonical 文件的 sha1,任何内容变化即失效(`runmark.py` 指纹思想)。

### D14: 打包分两阶段——内部包先行,公开包与框架整合合并为同一动作

(2026-10-24 新增。)阶段一:引擎落在 workspace 内部包 `packages/evolve-engine/`,**不发 npm**——拿到库边界的全部好处(协议隔离、独立 golden 测试、引擎迭代不扰动宿主),不付 semver/文档/发布的维护税。阶段二:第二个真实消费者出现时(首先是 agent-framework)提升为公开 npm 包;API 由第二个消费者的需求倒逼定义,框架以依赖方式消费引擎并写自己的 Substrate 实现,不把引擎折叠进框架代码。**理由**:harness2 自身不是库(无公开 API、无 semver),提前 SDK 化是为想象中的用户设计;Substrate 协议保证了阶段二的提升是低成本动作。**替代**:现在就发公开包——否决(YAGNI);引擎写死在 `src/evolve/`——否决,见 D1。

## Risks / Trade-offs

- [带外批准在 agent 有 shell 能力时可被绕过] → TTY 检测 + 拒绝非交互环境作为第一道防线;更强的方案(OS 级确认、一次性令牌)列为开放问题。**这是已知的、未被完全解决的风险**,在 `auto-A` 之前必须再评估。
- [事件只覆盖经 gateway 投递的 agent] → 文档与 doctor 输出里明确列出"哪些 agent 有观察、哪些只有 doctor/sync 信号",不假装全覆盖。
- [元数据信号的价值未经真机验证] → tasks 第 1 组先做真机采样,再决定 `observe` 级别采集哪些字段;信号质量不足则收缩范围而不是硬做。
- [编辑在会话中途改变 skill 会让 agent 行为不可解释] → 见 Open Questions 的"会话快照"。
- [editor 幻觉出貌似合理的编辑] → 证据要求 + 机械校验器 + 丢弃留痕 + Class C 即使产出也拒绝。
- [L1 差集漏掉语义回归(配置能解析但行为变差)] → 接受;L2 正为此存在,`auto-A` 限于风险面是结构性的编辑。
- [agent-bridge 未完成] → L1 降级为 rule-based 提案;`runDelegatedCall` 是 editor 路径的唯一硬依赖。
- [运行档案与信号无限增长] → 轮转策略后置,先手工清理。

## Migration Plan

1. **引擎移植与 golden 对照**(`packages/evolve-engine/`,宿主无关,可与托管工作并行;借 harness2 `tests/` fixture 做 Python/TS 同输入比输出)。
2. **托管扩展点**(纯增量、默认无订阅者,行为零变化),单独可发版;与移植并行、先于适配层。
3. TrellisSubstrate 适配层 + 进化的 `off`/`observe` 级别(环境式接入,只采集,无任何写入),真机验证信号质量。
4. `propose`(待批提案,带外批准,L1 前闸端到端)。
5. `auto-A` 仅在多次有人监督的运行证明无误报后,按用户显式选择开启;L2 执行、探针任务集、递归预算作为后续独立变更;**阶段二(公开包)等第二个消费者出现再启动**。

回滚:托管侧全部纯增量;引擎包可整体移除,宿主不受影响;停用进化 = 级别设回 `off`;已应用的编辑可在其备份会话中还原。

## Open Questions

- **移植落点**:已定(2026-10-24)——两阶段打包,见 D14,不再开放。
- **prompt 模板语言**(移植前置决定):默认原样保留英文(已验证资产,降低移植偏差);若中文化,须重建 golden 对照集。除移植开始前提出异议外不再复议。
- **python3 编译探针的环境跳过**(已定,2026-10-24 记录):`compile(src, rel, "exec")` 的 TS 等价实现是 spawn `python3` 编译探针;python3 缺席时跳过脚本编译检查。这是**环境差异而非语义偏差**,不计入 D7/D11/D12 的三处显式偏差;探针只属 `validate_tree` 的脚本子项,真机 preflight 不依赖它(且开发机 python3 可用)。记录于此使 `tree.ts` 头注释的"design 评审记录"指向闭合。
- **扩展加载机制**:已定(2026-10-24,8.1)——**canonical 扩展清单 + `activate` 契约**。清单为 `~/.trellis/mcp/extensions.yaml`(与 `servers.yaml`/`agent-bridge.yaml` 同目录,沿用"gateway 接线声明都放 `mcp/` 下"的既有惯例;仅 gateway 消费,不参与 agent 原生渲染)。条目显式声明 `id` 与 `load` 模块说明符(阶段一为绝对路径/文件 URL;阶段二公开包后可为包名);**仅清单内条目会被装载**,不做目录扫描、不做约定名猜测。装载契约:模块导出 `activate(ctx)`,返回 `{ providers?, subscribers? }`——**provider 与事件订阅者走同一注册面**,一条扩展可只出订阅者。recorder 就是订阅者型扩展:由**进化启用命令**在级别升至 `observe` 及以上时写入清单条目(`load` 指向宿主安装内 evolve recorder 的模块说明符),级别置回 `off` 时移除条目;gateway 启动时读清单、动态 import、按条目 try/catch 装载,单条目失败告警隔离。gateway 代码对进化零 import(托管不依赖进化);默认 `off` 即无条目,结构上零副作用。**替代**:约定名 npm 包自动发现——否决(阶段一无 npm,且违背"显式声明");gateway 硬编码动态 import 进化路径——否决(托管依赖进化);目录扫描 `extensions.d/`——否决(隐式,失败面更大),保留为将来 drop-in 需求出现时的扩展形态。
- **进化状态目录的具体路径**:已定(2026-10-24,8.1)——**`~/.trellis/evolve/`**,沿用 OAuth 凭据"存于 canonical 之外、仍在 `~/.trellis` 根下"的既有做法(`mcp/oauth/`、`tasks/`、`backups/` 同款)。其下按用途分子目录:`signals/`(recorder 按进程分文件追加的信号)、`archive/`(运行档案:提案/探针/verdict/备份会话标识/L2 比较记录)、`pending/`(待批提案存储)。该目录由进化子系统独占写入、只追加,不属 canonical 内容面(agents.md/skills/MCP 定义/memories),`trellis sync` 等读面不消费它。**替代**:`~/.local/share/trellis/evolve`(XDG)——否决,仓库既有状态全部收在 `~/.trellis` 根下,另开第二根无收益;`~/.trellis/` 下散置文件——否决,轮转/清理需要一个独占子根。
- **会话快照**(已定,2026-10-25,9.4② 核实读取路径后决定):**不做会话快照**。核实结果:skills 与 memories 的 runtime provider(`SkillProvider`/`RuntimeMemoryProvider`)是**每请求实时读取**——每次 `skills/list`/`skills/get`/memory `list`/`read` 都重新 `loadCanonicalSource({homeDir, workspaceDir})`,skill/memory 字节在调用时从盘读;instructions 不走 MCP,只经原生渲染文件投递(文件在 `trellis sync` 时定稿,会话中途不变)。因此"会话中途漂移"只影响 MCP 投递面,而进化的编辑模型(11.5:会话结束后的一次性作业 + 单实例锁;12.5:采纳后才触发同步)保证编辑永不发生在会话进行中;provider 的实时读取同时是管理面命令(doctor/sync)看到当前态的必需行为。决定:维持实时读取,托管不新增会话快照能力;若将来出现"会话进行中必须改 canonical"的需求再评。**替代**:进程启动时固定 canonical 快照——否决,会改变所有 MCP 投递面的现有行为,收益场景被作业模型排除。
- **observe 采集字段**(已定,2026-10-25,9.4① 真机采样后决定):**采集事件白名单的全部字段,内容级信号不从事件捞**。真机采样(2026-10-25,以真实 canonical 的临时副本 + 8.6 recorder 扩展驱动一个真实 gateway 进程,零上游 spawn、零模型调用)观察到的事件流形态:`session_start{ts, agent, session, workspaceRoot}` → `tool_call{ts, agent, session, provider, tool, durationMs, result}` × N(ok/error 均出现,`skills_read` 指向不存在的 skill 时 result=error)→ `session_end{ts, agent, session}`,同一 session 标识贯穿。可派生的信号:按 `(provider, tool)` 的调用量/错误率/超时率与耗时分布(如 `skills_read` error 率抬升 ≈ agent 在找不存在的 skill)、会话时长与会话密度、workspace 归属分布(采样即观察到用户 home 本身是一个 workspace root 的真实形态)。**结构性上限**(8.2 白名单的必然推论,决定采集策略):入参/结果不出事件,因此"哪条 skill/memory 被读""用户纠正内容"不可从事件得出——这类内容级信号一律走 11.2 的 agent 显式上报入口,observe 不从事件流捞内容;native 渲染 agent 不产生事件,其信号只有 doctor/sync 检查(11.4 已在 doctor 输出中区分两类)。recorder(11.1)据此按进程分文件追加全部白名单字段,不做字段裁剪。
- **用户纠正的采集形态**:agent 主动上报是已定入口;是否另做从会话中收割,可后置。
- **探针任务集的归属**:canonical 还是 per-workspace,P4 启动时再定。
- **`auto-A` 的准入门槛**:需要多少次有人监督且无误报的运行,以及带外批准的更强形态。
