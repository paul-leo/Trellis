# Spec Delta

## Purpose

让 Trellis 托管内容(skills、MCP 定义、指令、scope、记忆)在 runtime 上随使用自动改进:环境式观察产生信号,按阈值触发一次性作业,带证据的提案先在 staging 候选上验证,按风险分级采纳且批准走带外通道,所有写入可单点回滚,被采纳的编辑沉淀为教训回流到后续提案。该子系统可选安装、分级开启,并且只通过托管的通用扩展点接入。

## ADDED Requirements

### Requirement: 可选安装与分级开启
自我进化 SHALL 默认处于 `off` 级别。系统 SHALL 提供四个有序级别:`off`、`observe`(只采集信号)、`propose`(产出待批提案)、`auto-A`(仅 Class A 在 probe 通过后自动采纳)。级别 SHALL 可按全局默认、按 agent、按 workspace 分别设置,更具体的设置覆盖更宽泛的;开启 SHALL 是用户的显式选择,SHALL 被写入 canonical 并出现在 `trellis doctor` 的输出中,SHALL NOT 被静默开启。处于 `off` 时,系统 SHALL NOT 记录信号、SHALL NOT 拉起后台作业、SHALL NOT 产生任何写入。

#### Scenario: 默认关闭且零副作用
- **WHEN** 用户从未开启自我进化并运行若干 agent 会话
- **THEN** 不存在信号记录、后台作业或运行档案,托管行为与未安装时一致

#### Scenario: 更具体的级别覆盖更宽泛的
- **WHEN** 全局默认为 `observe`,某 workspace 设置为 `off`
- **THEN** 在该 workspace 内的会话不记录信号,其他位置的会话仍记录

#### Scenario: 开启状态对 doctor 可见
- **WHEN** 某 agent 被设置为 `propose`
- **THEN** `trellis doctor` 的输出列出该 agent 的进化级别

### Requirement: 单向依赖与可卸载
自我进化 SHALL 只通过托管的 `host` 子路径与事件机制接入托管,SHALL NOT 引用托管的其他内部模块。卸载自我进化 SHALL NOT 改变托管层的任何行为。

#### Scenario: 依赖边界被测试强制
- **WHEN** 对自我进化的源码做依赖检查
- **THEN** 其对托管的全部引用都落在 `host` 子路径与事件接口之内

### Requirement: 观察只记录元数据
系统 SHALL 在 `observe` 及以上级别订阅托管的工具调用与会话生命周期事件,并把其中的元数据写入信号存储。信号 SHALL 采用字段白名单(时间戳、agent、会话、provider、工具名、耗时、结果类别、层归属),SHALL NOT 记录任何入参或结果载体,所有字符串字段 SHALL 在写入前通过 secrets 擦除。层归属 SHALL 由"会话开始"事件携带的 workspace root 派生:该会话内全部信号归属该 workspace 层;无 workspace 归属的会话记为全局层。除被动事件外,系统 SHALL 提供一个 agent 可调用的上报入口用于记录用户纠正,该入口记录的文本 SHALL 同样经过 secrets 擦除。进化系统自身的调用与编辑 SHALL NOT 作为信号被记录。

#### Scenario: 载荷不入库
- **WHEN** 一次被观察的工具调用入参中含有凭据形态的字符串
- **THEN** 信号存储中不存在该字符串

#### Scenario: 进化自身活动不自激
- **WHEN** 进化系统的后台作业调用了工具或应用了编辑
- **THEN** 这些活动不产生新的信号

#### Scenario: 用户纠正被主动上报
- **WHEN** agent 在用户纠正其错误后调用上报入口
- **THEN** 一条 kind 为 `user-correction`、带层归属的信号被写入,文本已过擦除

### Requirement: 信号存储可并发且只追加
信号存储 SHALL 支持多个 agent、多个会话并发写入而无需全局锁,SHALL 为只追加。每条信号 SHALL 携带来源种类、稳定标识(来源提供时)、采集时间与层归属。可选信号源(agent-bridge 委托记录)缺席 SHALL NOT 使运行失败。

#### Scenario: 并发会话互不阻塞
- **WHEN** 两个 agent 的会话同时写入信号
- **THEN** 两方的信号都被完整保留,且任一方不因对方而等待锁

#### Scenario: 可选源缺席
- **WHEN** 不存在 agent-bridge 委托记录
- **THEN** 运行以其余信号源继续,并把该可选源记为 unavailable 而非 error

### Requirement: 触发是事件驱动的一次性作业
系统 SHALL NOT 依赖常驻进程。在会话结束事件(以及下次会话启动时对遗漏的补偿检查)上,系统 SHALL 依据信号数量、严重度与冷却期判断是否值得运行,满足条件时拉起一次性的后台作业,作业结束即退出。同一时刻 SHALL 至多有一个作业在运行。委派 editor 的预算上限、冷却期与每日提案上限 SHALL 可配置,超限时 SHALL 跳过而不是排队。

#### Scenario: 会话结束触发判断
- **WHEN** 一个会话正常结束且累计信号超过阈值、不在冷却期内
- **THEN** 一个一次性后台作业被拉起,作业结束后无残留进程

#### Scenario: 强杀后的补偿
- **WHEN** 上一个会话被强制终止而未发出结束事件,下一个会话启动
- **THEN** 启动时的补偿检查仍会评估累计信号并按阈值决定是否运行

#### Scenario: 单实例
- **WHEN** 一个作业正在运行时又有会话结束并满足触发条件
- **THEN** 不会启动第二个作业

#### Scenario: 超出预算时跳过
- **WHEN** 当日提案数已达上限
- **THEN** 本次触发被跳过并记录原因,不排队

### Requirement: 提案必须挂证据
每条编辑提案 SHALL 携带至少一个证据链接:某次运行标识、某个 doctor finding 标识或一条已记录的用户纠正。缺少证据的提案 SHALL 在 probe 前被丢弃,丢弃及原因 SHALL 记入运行档案。

#### Scenario: 无证据提案被丢弃
- **WHEN** editor 输出中包含一条 evidence 为空的编辑
- **THEN** 该编辑不进入 probe,档案以 `no-evidence` 记录丢弃

### Requirement: editor 输出是不可信的
提案 SHALL 以结构化格式产出,并由机械校验器逐条复核 kind 白名单、target 白名单与证据要求;校验错误 SHALL 以可执行的说明文字反馈给 editor 并至多重试一次,再失败则丢弃。分级与目标合法性 SHALL 由代码按 kind 与 target 计算,SHALL NOT 采信 editor 自报的风险等级。

#### Scenario: 校验失败带反馈重试一次
- **WHEN** editor 的首次输出有一条编辑违反 kind 白名单
- **THEN** 违规原因被反馈给 editor 重试一次,重试后仍违规则该编辑被丢弃并归档

### Requirement: 受保护目标的硬排除
提案 SHALL NOT 以以下内容为目标:secret 或凭据材料、MCP auth 配置、受管 agent 集合、Trellis 自有表面之外的用户手写文件、自我进化自身的配置。editor 契约 SHALL 禁止这些目标,机械校验器 SHALL 拒绝任何以它们为目标的编辑,被拒绝的编辑 SHALL 归档且 SHALL NOT 被 probe 或采纳。

#### Scenario: 指向 auth 的编辑被拒绝
- **WHEN** editor 产出一条目标为某 MCP server `auth` 块的编辑
- **THEN** 校验器拒绝它并归档,不为其执行 probe

#### Scenario: 指向进化自身配置的编辑被拒绝
- **WHEN** editor 产出一条修改进化级别设置的编辑
- **THEN** 校验器拒绝它并归档

### Requirement: 层级归属与隔离
系统 SHALL 把每条信号、提案、verdict 条目与 lesson 归属到恰好一个层:全局 canonical 或某个具体 workspace root。提案 SHALL 声明目标层,校验器 SHALL 拒绝目标不属于所声明层的编辑。在单个 workspace 采集的证据 SHALL NOT 仅凭自身产出对全局层的编辑;把源自 workspace 的修复升格到全局层 SHALL 需要另一上下文的匹配证据或显式人工批准。以 workspace 为目标的编辑 SHALL 满足 workspace 层的可提交约束(只允许 `${VAR}` 引用,绝不写凭据形态的字面值),并 SHALL 视为对外副作用而要求确认。

#### Scenario: workspace finding 产出 workspace 层提案
- **WHEN** doctor 对仓库 X 的 `.codex/config.toml` 报告 `workspace-toml-invalid`
- **THEN** 提案以 X 的 workspace 层为目标,全局 canonical 不在提案范围内

#### Scenario: 跨层编辑被拒绝
- **WHEN** 编辑声明全局层但目标路径位于某仓库的 `.agents/` 内
- **THEN** 校验器拒绝它并归档,不运行 probe

#### Scenario: 不自动升格到全局
- **WHEN** 某修复只在一个 workspace 验证过,没有其他上下文的匹配证据
- **THEN** 全局层保持不变,其全局版本只被呈现等待显式批准

#### Scenario: workspace 编辑拒绝凭据字面值
- **WHEN** 一条 workspace 编辑会把凭据形态的字面值写入 `.agents/config.json`
- **THEN** 校验器以违反可提交约束为由拒绝它

### Requirement: 确定性候选 verdict 差集(L1)
对配置类提案,系统 SHALL 通过托管门面把提案应用到 canonical 的 staging 副本,并用同一组结构化检查(doctor findings、`sync --check`、secrets audit)分别为 baseline 与候选计算 verdict。提案 SHALL 仅当候选 verdict 不引入新条目、解决了其目标条目、且其余条目不变时才可采纳,且各条目 SHALL 带着层归属参与比较。staging SHALL 复现被测上下文的层分裂。在 L1 适用域(配置类 kind 白名单)内,该 verdict 差集 SHALL 是唯一采纳判据,不另运行模型评分;本期系统 SHALL 只对 L1 适用域产出提案,内容类提案在 L2 选择器执行落地前不产出。

#### Scenario: 命中的修复可采纳
- **WHEN** baseline 含 `workspace-toml-invalid`,候选不含,且无其他差异
- **THEN** 提案被标记为可采纳,两份 verdict 入档

#### Scenario: 引入回归则不可采纳
- **WHEN** 候选解决了目标条目但引入 baseline 中不存在的条目
- **THEN** 提案被标记为不可采纳,新条目入档

#### Scenario: 被 workspace tombstone 的全局编辑不影响该 workspace
- **WHEN** 一条对全局条目的编辑,而该条目在被测 workspace 中被 tombstone
- **THEN** 该 workspace 的 verdict 不因此变化

### Requirement: 风险分级与采纳门
每条编辑 SHALL 被分类。Class A(可逆、零爆炸半径、有证据)SHALL 仅在级别为 `auto-A` 且 probe 通过时可自动采纳,采纳后 SHALL 通知用户。Class B(内容或路由编辑)SHALL 永远需要人对 diff 与证据的显式批准,不受级别影响。无法分类的编辑 SHALL 按 Class B 处理。以全局层为目标、仅由单 workspace 证据支撑的升格编辑 SHALL 一律按 Class B 处理。

#### Scenario: Class A 自动采纳并通知
- **WHEN** 级别为 `auto-A`,一条 Class A 提案 probe 通过
- **THEN** 编辑被应用,通知中指明编辑、证据与回滚路径

#### Scenario: 低于 auto-A 时 Class A 也不自动采纳
- **WHEN** 级别为 `propose`,一条 Class A 提案 probe 通过
- **THEN** 它被呈现等待批准,不被应用

#### Scenario: 无法分类按 Class B
- **WHEN** 一条编辑不匹配任何已知分类规则
- **THEN** 它被当作 Class B 呈现等待批准

#### Scenario: 升格编辑按 Class B
- **WHEN** 一条以全局层为目标的编辑仅由单 workspace 证据支撑,且级别为 `auto-A`
- **THEN** 它被当作 Class B 呈现等待批准,不自动采纳

### Requirement: 批准只走带外通道
被进化的 agent SHALL NOT 能批准其自身的进化。暴露给 agent 的接口 SHALL 仅限于读取 pending 提案与上报纠正,SHALL NOT 包含任何批准、拒绝或应用类操作;任何由 agent 传入的"确认"参数 SHALL NOT 被视为批准。批准 SHALL 只能经由管理面命令在交互式终端中完成,当检测到非交互环境时 SHALL 拒绝。

#### Scenario: agent 接口没有批准能力
- **WHEN** 列出暴露给 agent 的全部进化接口
- **THEN** 其中不含批准、拒绝或应用类操作

#### Scenario: 非交互环境拒绝批准
- **WHEN** 在没有交互式终端的环境中执行批准命令
- **THEN** 命令被拒绝,提案保持 pending

### Requirement: pending 提案对 agent 可见
系统 SHALL 把 pending 提案以只读方式暴露给 agent,使 agent 能在会话中告知用户有待批提案;`trellis doctor` SHALL 同样列出 pending 数量。暴露内容 SHALL 不包含任何凭据材料。

#### Scenario: agent 能读到待批提案
- **WHEN** 存在两条 pending 提案,agent 读取 pending 列表
- **THEN** 返回两条提案的摘要、证据与风险级别,不含凭据

### Requirement: 单会话写入与单点回滚
一次运行产生的全部写入 SHALL 发生在托管提供的同一个备份会话内,使一次回滚即可恢复运行前的确切状态。运行档案 SHALL 记录该备份会话标识。

#### Scenario: 多编辑运行整体回滚
- **WHEN** 一次运行应用了三条编辑,用户回滚该会话
- **THEN** 三条编辑全部被还原

### Requirement: 采纳的生效边界
采纳 SHALL 在 runtime 投递的 agent 上于其后续会话读取 canonical 时自然生效,无需额外同步;仅依赖原生渲染的 agent SHALL 在采纳后触发同步。系统 SHALL 在应用后向用户说明各 agent 的生效时点。

#### Scenario: runtime agent 下个会话读到新版本
- **WHEN** 一条 skill 编辑被采纳,随后某 runtime agent 开启新会话
- **THEN** 该会话读取到编辑后的 skill,无需用户运行同步

#### Scenario: 原生渲染 agent 触发同步
- **WHEN** 一条编辑被采纳且某 agent 仅有原生渲染产物
- **THEN** 系统为其触发同步并报告结果

### Requirement: 运行档案与 probe 缓存身份
每次运行 SHALL 在进化状态目录下持久化完整档案:信号、全部提案(含被丢弃与被拒绝的及其原因)、probe 记录、verdict、采纳决策与备份会话标识。进化状态 SHALL 与 canonical 分离存放。Probe 结果 SHALL 以被测 canonical 切片的内容摘要为键缓存,切片任何变化 SHALL 使缓存失效。

#### Scenario: 切片变化使缓存失效
- **WHEN** 某切片已有 probe 缓存,且该切片内容变化
- **THEN** 下次运行重新计算而不复用

### Requirement: 带证据且带作用域的教训沉淀
被采纳的编辑 SHALL 产出一条 lesson,含 cue、正文与证据链接,confidence 可选,并携带层作用域。canonical 记忆已启用时,lesson SHALL 经现有记忆管道写入;未启用时 SHALL 保留在运行档案且运行不失败。后续提案生成 SHALL 只把 lesson 呈现给匹配的上下文:全局 lesson 处处可见,workspace lesson 只给该 workspace,对其他上下文仅作为升格审批的跨项目佐证。

#### Scenario: 记忆未启用时 lesson 留在档案
- **WHEN** 记忆未启用且一条编辑被采纳
- **THEN** lesson 连同证据存在于档案,运行把记忆报告为 skipped 而非 failed

#### Scenario: 项目教训不外溢
- **WHEN** 仓库 X 产生了一条 workspace 层 lesson,随后为仓库 Y 生成提案
- **THEN** 该 lesson 不会原样进入 Y 的提案上下文

### Requirement: 失败一律收口
probe 执行、verdict 计算、选择或作业调度中的任何失败 SHALL 被记录并按"不采纳"处理。测量失败 SHALL 记为 unknown,SHALL NOT 被表示为零分、通过或批准。

#### Scenario: probe 错误不等于批准
- **WHEN** 针对 staging 候选的检查以意外错误退出
- **THEN** 提案被标记为不可采纳并记录错误,不发生采纳

### Requirement: 匿名前后对比记录协议(L2)
执行内容类对比时,比较记录 SHALL 以类型化的档案格式持久化:baseline 与候选各自的运行标识、冻结的交付物引用、按任务设种子的匿名标识映射、选择器结果与失败收口的 verdict。base SHALL 保留在比较中,记录格式 SHALL 能表达"选中 baseline ⟹ 不采纳"与"选择器失败 ⟹ invalid"两种收口。本协议只定义记录格式与边界;选择器执行(运行比较与裁决)不在本期范围,其语义场景由后续变更交付。

#### Scenario: 比较记录可序列化往返
- **WHEN** 一条含匿名臂映射与失败收口 verdict 的比较记录被写入档案再读出
- **THEN** 全部字段在往返后保留,匿名标识不泄露哪一臂是候选

### Requirement: probe 工作区隔离
probe 执行 SHALL 在临时工作区中运行,仅含探针任务输入与 staging 渲染的配置,并使用隔离的 agent 配置 HOME。系统 SHALL NOT 绕过目标 agent 自身的审批或沙盒机制,SHALL NOT 传入禁用它们的标志,SHALL NOT 把工作区之外的用户数据暴露给 probe。

#### Scenario: 启动规格不含绕过标志
- **WHEN** 对任一目标 agent 发起 probe 执行
- **THEN** 启动参数中不含审批或沙盒绕过标志,工作目录为临时 probe 工作区

### Requirement: 管理面命令不触发进化循环
系统 SHALL 提供管理面命令:查看状态、列出 pending、批准、拒绝、启用、停用、回滚。这些命令 SHALL NOT 触发观察、提案或 probe 的执行;进化循环 SHALL 只由事件驱动。

#### Scenario: 命令不启动循环
- **WHEN** 用户运行查看状态命令
- **THEN** 不拉起任何提案或 probe 作业,也不写入任何信号
