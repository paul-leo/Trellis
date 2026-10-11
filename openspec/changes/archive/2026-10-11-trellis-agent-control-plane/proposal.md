# Proposal

## Why

Trellis 已经具备 Runtime SkillProvider、RuntimeMemoryProvider、MCP Gateway
和 MCP 授权存储，但 Agent 还缺少一个统一入口来感知“我是谁、当前 Runtime
有什么、哪些 MCP 已授权、哪些 Agent 被托管、全局提示词和 Memory 从哪里消费”。
同时，全局提示词目前主要通过各 Agent 的 native 文件投影，Memory 主要通过
canonical Markdown 或可选的外部 Memory MCP，onboard 中没有以统一能力模型呈现。

如果继续分别扩展这些能力，Agent 会得到多个互不关联的入口，无法稳定完成授权
引导、能力发现、跨 Agent 协作和任务交接。现在需要建立一个 Trellis Agent
Control Plane：每个 Agent 都有一个内置 Trellis Skill，Runtime 提供动态环境状态，
并为全局提示词、Memory、MCP 授权和未来任务交接定义统一协议边界。

## What Changes

- 增加一个 Trellis 自有的内置 `trellis-runtime` Skill，作为每个受支持 Agent
  的统一环境感知入口；Skill 内容保持短小，动态事实通过 Runtime 工具查询。
- 增加 Runtime 总览能力，向 Agent 提供当前 Agent 身份、Trellis 版本、托管状态、
  MCP 路由、Runtime delivery、Provider 能力和其他 Agent 概览。
- 将全局提示词定义为独立的 Instructions 能力：native 投影保证 Agent 启动时
  生效，Runtime resource/tool 用于查询、审计和跨设备消费；不把 MCP tool 当作
  强制 system prompt 的替代品。
- 统一 Memory 能力的消费模型：canonical Markdown 是 Trellis-owned source，
  RuntimeMemoryProvider 负责按需读取；外部 Memory MCP/graph 作为可选后端，
  通过 sync/extract 闭环，不把“工具存在”误报为“已有记忆内容”。
- 将 MCP 授权状态纳入控制平面：Agent 或用户可以看到 auth-required、timeout、
  unavailable、ready 及明确的下一步；初始 OAuth 仍只能由用户显式执行，Gateway
  不在后台打开浏览器。
- 增加 Agent 状态查询契约，区分 installed、managed、reachable、healthy，且不
  泄露 token、环境变量值、私有会话或完整隐藏 prompt。
- 定义未来的任务交接协议：先支持持久任务创建、claim、handoff、update、complete
  和 lease；不在本变更中允许 Agent 随意启动或控制另一个 Agent。
- 保持现有短工具名和冲突消歧规则，控制平面内置工具使用稳定的 `trellis.*`
  命名，并确保 Agent-facing 工具不会无必要地携带多层 server 前缀。

## Capabilities

### New Capabilities

- `agent-control-plane`: Agent 感知、Runtime 总览、Agent 状态、内置 Trellis
  Skill、授权状态和跨能力发现的统一契约。
- `runtime-instructions-provider`: 全局提示词的 native 强制投影与 Runtime
  查询/资源消费边界。
- `agent-task-handoff`: 面向未来跨 Agent 协作的持久任务、claim、lease 和交接
  契约，不包含任意 Agent 远程执行。

### Modified Capabilities

- None. Existing onboarding, MCP Gateway, Skill sync and Memory specs remain
  individually valid; this change adds the cross-capability control-plane
  contract that composes them.

## Current State and Gaps

- `SkillProvider` 已支持 Skill search/read/resource；但没有统一的内置 Trellis
  Skill 指导 Agent 何时调用这些工具。
- `RuntimeMemoryProvider` 已支持 `trellis.memory.search/read`，但当前 canonical
  Memory 可能为空；这不应被解释为 Memory 未托管。
- 全局提示词 `~/.trellis/agents.md` 已可投影为各 Agent native instructions，
  但 onboard 里只作为 `instructions` 迁移类别出现，没有 Runtime Instructions
  Provider。
- `trellis.mcp.status` 已能报告上游状态和授权 remediation，但尚未成为统一
  Control Plane 的标准启动感知流程。
- Agent 状态 Provider 和任务交接 Provider 尚未实现。

## Impact

- `src/lib` Runtime provider registry、Agent probes、onboard capability model、
  adapters 和文档。
- 每个 Agent 的 native Skill/instructions 投影以及 Kimi Runtime-only delivery。
- 新增只读 Runtime 工具和 resources；未来任务交接增加受控的本地持久化状态。
- 不改变 OAuth token 的 0600 存储策略，不把 secrets 放入 Runtime 返回值，不默认
  开启跨 Agent 任意执行。
