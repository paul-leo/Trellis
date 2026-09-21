# Proposal

## Why

Trellis 统一管理五个独立的 Code Agent CLI（Claude Code、Codex、Kiro、pi、Kimi Code）的配置，但这些 Agent 彼此完全隔离——即使某个 Agent 更擅长特定任务（审查、某个模型的推理风格等），也没有标准化的方式让一个 Agent 把工作委派给另一个去做。用户希望在保留每个 Agent 独立优势、且不引入额外编排 Agent 或跨机器协议的前提下，让受管 Agent 可以互相把对方当"子 Agent"调用。

## What Changes

- 新增一个 MCP provider（挂载在现有 `trellis mcp-gateway` 进程里，与 `TaskProvider`/`SkillProvider` 同级），把"调用另一个受管 Agent 执行一次性任务"包装成标准 MCP 工具（如 `agent.codex.run`），复用各 CLI 已验证的无交互模式：
  - Claude Code：`-p/--print` + `--output-format json`
  - Codex：`codex exec`
  - Kimi Code：`-p, --prompt` + `--output-format text|stream-json`
  - pi：`--print, -p` + `--mode json|rpc`
- 新增声明式的"Agent 能力清单"，描述哪些受管 Agent 支持被调用、擅长标签、调用参数与超时约束，供调用方在 MCP 工具列表中发现，而不是硬编码调用关系
- 新增委派深度限制，防止 A→B→A 循环委派
- 复用现有 `~/.trellis/tasks/tasks.json` 持久化机制记录每次跨 Agent 调用（谁调用了谁、何时、结果摘要），供 `trellis doctor` 展示审计信息
- Kiro **明确排除在本次 MVP 之外**——本机未安装 `kiro-cli`，无法验证其无交互调用能力；作为独立验证项留给后续变更，不阻塞本次交付
- 新增委派深度限制（默认 2 跳），通过 `TRELLIS_DELEGATION_DEPTH` 环境变量沿真实进程链传递，达到上限时拒绝且不 spawn
- 新增可选的目标"人设/角色"（persona）：能力清单里可配置每个目标的默认 persona，单次调用也可覆盖；有原生占位符的走原生参数注入，没有的话 fallback 成 prompt 前置说明
- 新增会话延续：从目标的 json/stream-json 输出里尽力提取会话 id 返回给调用方；目标可配置单独的"续接"调用模板，调用时带上会话 id 即可续接同一段对话，未配置续接模板时明确报错而不是静默开新会话
- 不新增会做路由决策的管理者/编排 Agent——调用方 Agent 自己的模型决定是否委派，与现有 MCP 工具选择机制一致
- 不引入常驻 daemon 或跨机器协议（不含 A2A），场景限定在单机、同一用户下的多个 Agent 进程之间
- 不包含可视化 GUI——用户明确要求先打通"能否相互调用"的能力层，界面是下一个独立需求

## Capabilities

### New Capabilities
- `agent-bridge-delegation`: 受管 Agent 之间通过 MCP 工具互相委派一次性任务执行的能力，涵盖能力发现（谁支持被调用、擅长什么）、委派深度限制防循环、以及调用审计记录

### Modified Capabilities

（无——本次改动是在现有 `mcp-gateway-hosting` 进程里新增一个 provider，不改变该能力已声明的任何一条 requirement，做法与现有 `TaskProvider`、`SkillProvider` 的接入方式一致）

## Impact

- `src/lib/mcpRuntime.ts`：`BuiltinRegistry` 注册新 provider
- `src/commands/mcpGateway.ts`：provider 列表新增一项
- 新增 provider 实现文件 + Agent 能力清单的 schema/加载逻辑
- `~/.trellis/` 新增能力清单文件（具体格式与位置在 design 阶段确定）
- 复用 `src/lib/taskStore.ts` 记录调用审计
- `trellis doctor` 输出扩展，展示跨 Agent 调用记录
- 不影响现有 CLI 命令行为，是纯增量能力；不影响 Kiro 现有配置
