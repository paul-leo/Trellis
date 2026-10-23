# Proposal

## Why

上游 HTTP MCP server 的会话失效（server 重启、会话 TTL 到期、负载均衡切换实例）会让
网关客户端持有的 `Mcp-Session-Id` 永久过期：SDK 不重新 initialize，网关也没有重连
路径，此后该上游的**每一个工具调用都原样失败**（真机报错：`-32000 "MCP session no
longer exists; initialize a new session"`），直到用户重启 agent 会话。同时网关状态
一直显示 `ready`（失真），错误信息只带 `provider "upstream"` 不带 server 名，用户
无从定位。多 agent 长会话场景下这会把一次上游抖动放大成整个工具面瘫痪。

## What Changes

- **新增 mid-session 会话失效检测**：在网关调用路径识别"上游会话不存在"类错误
  （`SdkHttpError` status 404 + `/session/i`；`ProtocolError` code -32000 +
  `/session/i` 兜 modern-era 400 包裹路径），排除 401/403（OAuth/鉴权路径归既有
  401 恢复机制管，绝不进重连路径）。
- **新增 per-server 自动重连恢复**：检测到会话失效后，per-server single-flight
  重建上游 client（删旧 client、复用 `addUpstream` 全套连接逻辑），等待中的并发
  调用重试一次；带冷却期防重连风暴。
- **registry/resources 支持热替换**：`McpToolRegistry` 新增 `replace(serverName,…)`；
  `UpstreamResources` 清理该 source 的陈旧 `files` 路由。
- **状态诚实化**：`UpstreamStatusKind` 增加 `reconnecting` 过渡态；任何会话失效
  未成功恢复都落失败态（`requiresSessionRestart: true`），不再停留假 `ready`。
- **错误带 server 名**：网关调用错误信息包含具体上游 server 名，替代只有
  `provider "upstream"` 的现状。
- **已知取舍（明确写进 spec）**：重连后上游工具集若变化，exposed tool name 全局
  重排，旧 exposed 名失效、下次 `tools/list` 生效；本期不实现 `listChanged` 通知。

## Capabilities

### New Capabilities

（无——全部行为落在既有 `mcp-gateway-hosting` capability 内）

### Modified Capabilities

- `mcp-gateway-hosting`:
  - 新增 requirement：上游会话失效的 mid-session 自动恢复（检测判据、single-flight
    重连、重试一次、冷却期、失败终态、与其他上游隔离）。
  - 修改 requirement "One upstream's connection failure does not affect any other
    upstream"：mid-session 会话失效从"只能重启"改为"可自动恢复"，且失败态必须如实
    上报（不假 ready）。

## Impact

- **代码**：`src/lib/gatewayBackend.ts`（调用路径检测、single-flight 重连、状态机）、
  `src/lib/mcpToolRegistry.ts`（replace 语义）、`src/lib/upstreamResources.ts`
  （files 路由清理）、`src/lib/mcpConnect.ts`（无需改动，重连复用 `connectServer`）。
- **测试**：`test/unit/gatewayOauthRuntime.test.ts` 的 loopback fake server 需扩展为
  下发并校验 `Mcp-Session-Id`（当前不发不校验，无法触发会话失效）；新增并发单飞、
  冷却、403 不触发、OAuth 组合等用例。
- **SDK 依赖**：无新增依赖；行为依据 `@modelcontextprotocol/client` 2.3.1 与
  `@modelcontextprotocol/server` 的会话失效惯例（404/-32001 "Session not found"）。
- **兼容性**：无 breaking change；stdio/gateway 两种投放模式同样受益；mcp-runtime
  与 mcp-gateway 共用 `GatewayBackend`，一处修复两处生效。
- **里程碑**：M1 = 检测 + 失败态 + 错误带 server 名（独立可验收）；M2 = single-flight
  重连 + replace + 重试。
