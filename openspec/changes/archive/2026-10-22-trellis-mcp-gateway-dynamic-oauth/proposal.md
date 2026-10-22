# Proposal

## Why

网关对 Trellis-owned OAuth 上游的 `Authorization: Bearer` 是在上游连接时一次性烧进 transport 静态 headers 的（`withOAuthHeader` → `connectHttp` 的 `requestInit.headers`），进程存活期间不再变化。会话寿命一旦超过 access token 寿命（morphix 约 1 小时），后续每次工具调用都会 401，直到 Agent 重启会话；会话中途用 `trellis mcp auth` 重新授权写的最新 token，运行中的网关也看不到。执行点多、会话长的使用方式（多 Agent 并行）会把短 token TTL 变成反复出现的"死凭据"事故，而唯一的恢复手段是重启。

## What Changes

- Trellis-owned OAuth HTTP 上游改用 SDK `AuthProvider` seam 注入凭据：`token()` 在**每次出站 HTTP 请求**组 header 时解析当前存储 token（已验证 `@modelcontextprotocol/client` 2.3.1 的 `_commonHeaders()` 逐请求调用 `authProvider.token()`），替换连接时一次性烧录。
- 提前刷新窗口从 60s skew 加宽到 5 分钟：请求触发时 token 剩余寿命不足即先刷新再发请求（沿用既有 per-server 锁与锁内重读去重）。
- `onUnauthorized`（401）→ 强制刷新一次 + SDK 自动重试该请求一次；仍失败则只影响该 server 的本次调用，错误信息带 `trellis mcp auth <name>` remediation，并把该上游状态标为 needs-auth（`mcp_status` 可见）。
- `token()` 内刷新失败不得抛裸异常打断请求管道：返回旧 token 让请求自然 401，进入上面的 401 恢复路径。
- 跨进程即时生效：因为每次请求从磁盘读 token 文件（无内存缓存），`trellis mcp auth` 写盘后运行中的网关下一个请求即用新 token——零重启、零新对话。
- 不变的部分：stdio 上游、非 OAuth 上游、canonical 中显式 `Authorization` header 优先、connect 时的 resource 绑定校验、`mcp-oauth-renewal` 命令本身（降级为锦上添花的预约刷新）。

## Capabilities

### New Capabilities

（无——行为落在既有网关能力内）

### Modified Capabilities

- `mcp-gateway-hosting`: 刷新时机 requirement 从"连接时或 `mcp auth` 重跑时"扩展为"连接时**且每次出站请求前**"；新增按请求解析凭据（跨进程写盘即时生效）、401 自动强刷重试一次、刷新失败按 server 隔离并上报 needs-auth 三条 requirement。

## Impact

- `src/lib/mcpConnect.ts`：`connectHttp`/`connectSse` 接受可选 `authProvider` 参数并透传给 transport（保持模块 consumer-agnostic 定位，参数即边界）。
- `src/lib/gatewayBackend.ts`：`addUpstream` 在 `withOAuthHeader` 命中时构造 Trellis `AuthProvider`（闭包持有 homeDir + server name + 状态回调），401/失败路径接入既有 `statuses` 上报。
- `src/lib/oauth/refresh.ts`：新增忽略过期判断的 `forceRefresh`（供 `onUnauthorized`，仍走锁与轮换语义）；提前刷新 skew 通过既有 `RefreshOptions.skewMs` 透传，`store.ts` 默认值不动。
- 测试：用 fake token 文件 + 本地 HTTP MCP 上游钉住"中途过期自动刷新""外部写盘下一请求生效""401 强刷重试""invalid_grant 隔离与状态上报"四条行为。
- 无 canonical schema 变更、无 CLI 变更、无新依赖（SDK 已内置该 seam，已在 2.3.1 源码验证）。
