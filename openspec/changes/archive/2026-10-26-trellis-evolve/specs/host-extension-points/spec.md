# Spec Delta

## Purpose

为托管层提供与任何具体消费者无关的通用扩展点:元数据事件流、会话生命周期事件、窄门面的公开写入/回滚/检查接口、外部扩展(provider 与事件订阅者)注册与故障隔离,使外部子系统(如自我进化)可以在不改变托管核心行为的前提下接入。

## ADDED Requirements

### Requirement: 工具调用事件只含元数据
runtime 对经其路由的每次工具调用(无论是内建 provider 还是上游 MCP server)SHALL 向已注册的订阅者发出一个事件,事件 SHALL 仅包含:时间戳、agent 标识、会话标识、provider 标识、对外暴露的工具名、耗时、结果类别(成功/错误/超时)。事件 SHALL NOT 包含工具入参、工具结果或其任何派生内容。

#### Scenario: 上游与内建调用都产生事件
- **WHEN** 一个会话依次调用一个上游 MCP 工具与一个内建 provider 工具
- **THEN** 订阅者收到两个事件,各自带 provider 标识与结果类别

#### Scenario: 事件不携带载荷
- **WHEN** 一次工具调用的入参中含有凭据形态的字符串
- **THEN** 订阅者收到的事件序列化后不包含该字符串的任何部分

### Requirement: 事件发出对调用路径透明
事件的发出与订阅者的处理 SHALL NOT 改变工具调用的结果、错误语义或可感知的延迟。订阅者抛出异常或处理缓慢 SHALL NOT 使工具调用失败或被阻塞;失败 SHALL 被吞掉并以警告记录。没有订阅者时,runtime 行为 SHALL 与未引入事件机制时逐字节一致。

#### Scenario: 订阅者抛异常不影响调用
- **WHEN** 订阅者在处理事件时抛出异常
- **THEN** 该次工具调用仍返回其原本的结果,且 runtime 记录一条警告

#### Scenario: 无订阅者零变化
- **WHEN** 没有任何订阅者注册
- **THEN** 工具调用的返回内容与列表行为与引入事件前一致

### Requirement: 会话生命周期事件
runtime SHALL 在 gateway 进程启动后发出"会话开始"事件,并在 client 断开(stdin 结束或关闭)或收到 SIGTERM、SIGINT、SIGHUP 时,在释放上游之前发出"会话结束"事件。会话标识 SHALL 由进程在启动时生成并在该进程的全部事件中保持一致。"会话开始"事件 SHALL 包含:时间戳、agent 标识、会话标识、进程观察到的 workspace root(供消费者派生层归属;无 workspace 归属时以空值表示);"会话结束"事件 SHALL 包含:时间戳、agent 标识、会话标识。系统 SHALL NOT 承诺在进程被强制终止(如 SIGKILL)或崩溃时发出"会话结束"事件,消费者 SHALL 能容忍缺失的结束事件。

#### Scenario: 正常断开发出结束事件
- **WHEN** client 关闭 stdin 使 gateway 进入关闭流程
- **THEN** 订阅者在上游被释放之前收到"会话结束"事件,其会话标识与该进程此前所有事件一致

#### Scenario: 会话开始事件携带 workspace root
- **WHEN** gateway 进程在某 workspace root 下启动
- **THEN** 订阅者收到的"会话开始"事件带有该 workspace root,且与该进程后续事件的会话标识一致

#### Scenario: 强杀不保证结束事件
- **WHEN** gateway 进程被 SIGKILL 终止
- **THEN** 不要求发出"会话结束"事件,且后续会话启动不受影响

### Requirement: 订阅是显式的且可失败隔离
事件订阅 SHALL 只通过显式注册建立。订阅者的注册失败或运行期故障 SHALL NOT 影响 gateway 启动、其他订阅者或工具调用。

#### Scenario: 注册失败不阻断启动
- **WHEN** 某个订阅者在注册阶段抛出异常
- **THEN** gateway 仍正常启动,其他订阅者与全部工具照常可用,并记录一条警告

### Requirement: `host` 子路径提供窄门面
包 SHALL 通过独立的 `host` 子路径公开一组窄门面能力:读取指定层的 canonical 表面(只读)、对 canonical 的 scratch 副本做 staging、运行机器可读检查(doctor findings、`sync --check`、secrets audit)、在备份会话内应用编辑、回滚指定备份会话。该子路径 SHALL 只导出门面函数与类型,SHALL NOT 重新导出 `src/adapters/*` 或 `src/commands/*` 中的任何符号;包根入口的导出面 SHALL 保持不变。

#### Scenario: 门面不泄漏内部实现
- **WHEN** 检查 `host` 子路径的全部导出
- **THEN** 其中不含 adapters 与 commands 内部的任何符号,且根入口导出与引入前一致

#### Scenario: 编辑在备份会话内应用并可回滚
- **WHEN** 调用方通过门面在一个备份会话内应用多条编辑,随后回滚该会话
- **THEN** 全部编辑被还原,canonical 与应用前逐字节一致

#### Scenario: staging 不触碰真实 canonical
- **WHEN** 调用方对 staging 副本应用编辑并运行检查
- **THEN** 真实 canonical 与全部 agent 原生配置逐字节不变

### Requirement: 检查门面返回可比较的结构化结果
门面的检查 SHALL 返回结构化的、带稳定条目标识和层归属(全局或具体 workspace root)的结果,使调用方能在两次检查之间做集合运算。检查本身 SHALL 保持只读。

#### Scenario: 两次检查可做集合差
- **WHEN** 对同一 canonical 的 baseline 与 staging 副本各运行一次检查
- **THEN** 两份结果的条目可按稳定标识逐条比较,且每条带层归属

### Requirement: 外部扩展注册与故障隔离
gateway SHALL 仅从 canonical 扩展清单(`~/.trellis/mcp/extensions.yaml`,条目含 `id` 与 `load` 模块说明符)装载外部扩展;清单之外的模块 SHALL NOT 被装载,系统 SHALL NOT 通过目录扫描或约定名发现扩展。每个扩展模块 SHALL 导出 `activate`,返回 `{ providers?, subscribers? }`;provider 与事件订阅者 SHALL 经同一注册面装载,允许只出订阅者的扩展。单个扩展的 import、activate 或注册失败 SHALL NOT 影响核心 provider、上游 server、其他扩展或 gateway 启动,失败 SHALL 被报告而非静默。没有清单条目时,gateway 行为 SHALL 与引入该机制前一致。

#### Scenario: 仅清单内扩展被装载
- **WHEN** 磁盘上存在未在清单中声明的可加载模块
- **THEN** gateway 不装载它,工具列表与订阅者集合只反映清单条目

#### Scenario: 订阅者型扩展经同一契约装载
- **WHEN** 一个扩展的 `activate` 只返回 subscribers 而不返回 providers
- **THEN** 其订阅者收到该进程的事件,工具列表不受影响

#### Scenario: 扩展加载失败被隔离
- **WHEN** 声明了两个扩展,其中一个加载时抛出异常
- **THEN** 另一个扩展与全部核心 provider 照常工作,失败的扩展被报告

#### Scenario: 无扩展零变化
- **WHEN** 没有声明任何扩展
- **THEN** gateway 的工具列表与行为与引入该机制前一致

### Requirement: 托管不依赖其消费者
托管层(`host-extension-points` 之内的代码与既有托管代码)SHALL NOT 依赖任何通过这些扩展点接入的子系统。移除任一此类子系统 SHALL 使托管层的行为、测试结果与导出面保持不变。

#### Scenario: 移除消费者后托管测试照常通过
- **WHEN** 把自我进化子系统的源码整体移出构建
- **THEN** 托管层的构建与测试结果不变,且无任何对被移除代码的引用
