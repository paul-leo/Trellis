# Design

## Context

现状：`gatewayBackend.ts` 的 `addUpstream` 对 Trellis-owned OAuth 上游调用
`withOAuthHeader`，把 `Authorization: Bearer` 烧进静态 def.headers；`mcpConnect.ts`
的 `connectHttp`/`connectSse` 把它放进 `requestInit.headers` 一次性构造 transport。
进程存活期间 header 不再变化——这就是会话中途 401、外部重新授权不生效的根因。

已在本机 `@modelcontextprotocol/client` 2.3.1 源码验证的关键事实：

- Streamable HTTP 与 SSE transport 每次 POST/GET 组 header 都执行
  `_commonHeaders()`（index.mjs:5093、5713）：从 `requestInit.headers` 起底，
  再 `await this._authProvider?.token()` 并以返回值**覆盖** `Authorization`。
- 构造选项 `authProvider` 接受最小形状 `{ token(): Promise<string|undefined> }`
  （index.d.mts:375-390，官方示例即 "gateway-managed tokens"），另有可选
  `onUnauthorized()`：服务端 401 时调用，transport 随后**自动重试一次**。
- `RequestOptions.headers` 虽支持逐请求附加 header，但 `authorization` 在
  `RESERVED_REQUEST_HEADER_NAMES` 保留名单内（index.mjs:5296）会被丢弃——
  逐请求 header 覆盖方案不可行，`AuthProvider` 是唯一正门。

既有可复用机制：`refresh.ts` 的 `ensureFreshToken`（skew 判断 + per-server 锁 +
锁内重读 + 轮换写盘，`RefreshOptions.skewMs` 已可透传加宽窗口）；
`gatewayBackend.ts` 的 `statuses` map + `remediationKind: "oauth"` 上报词汇。

## Goals / Non-Goals

**Goals:**

- OAuth HTTP 上游的凭据按请求解析：本进程刷新、跨进程写盘、401 强刷重试三条
  路径全部零重启生效（见 specs 三条 scenario）。
- 失败隔离与可观测：刷新失败只影响单台上游的当次调用，状态上报走既有
  `statuses`/`remediationKind` 词汇，`mcp_status` 可见。

**Non-Goals:**

- stdio 上游（OAuth server 实际全部是 http/sse transport）。
- per-server connect timeout（`morphix-air-tasks` 那条线，另案处理）。
- `mcp auth` / `mcp renew` 语义变化（保持 60s 默认 skew 不动）。
- canonical schema / CLI / 依赖变化。

## Decisions

### D1: 注入点选 `AuthProvider` seam，而非逐请求 header 或重连换 token

备选对比：逐请求 `RequestOptions.headers` 被 SDK 保留名单排除（见 Context）；
"检测到 token 变化即拆连接重建 transport" 需要重跑 listTools 与工具重注册，
且 stdio 会话身份（`mcp-session-id`）与服务端状态引入额外复杂度。
`authProvider.token()` 逐请求调用 + `onUnauthorized` 自动重试一次，两者都是
SDK 内建行为，改动面最小。

### D2: 保留 connect 时烧录的 header，`AuthProvider` 作为增量覆盖

`withOAuthHeader` 原样保留：connect 时的 resource 绑定校验、"canonical 显式
Authorization 优先"判断都在这里，且 connect 后首个请求即使 provider 路径回归
也有可用 header 兜底（`_commonHeaders` 中 `token()` 返回 falsy 时不覆盖）。
失败即弃的方案（完全去掉静态 header）让 provider 成为单点，无兜底。

### D3: `token()` 内刷新失败不抛异常，返回旧 token

SDK 的 `_commonHeaders()` 会把 `token()` 抛出的异常直接抛出、中断本次请求。
设计为：预请求刷新失败（网络错/`invalid_grant`）→ 返回旧 token → 请求按原样
发出 → 服务端 401 → `onUnauthorized` 强刷 → SDK 自动重试。由此所有恢复收敛到
单一 401 路径，行为可预测且已被 scenario 钉死（"Pre-request refresh errors
never crash the gateway"）。

### D4: `onUnauthorized` = 强制刷新 + 状态上报，复用锁语义

`refresh.ts` 新增 `forceRefresh(homeDir, serverName, opts)`：在 `withServerLock`
内锁内重读（他方可能已刷新成功）→ 未刷新过则 `performRefresh` → `writeToken`。
与 `ensureFreshToken` 的区别仅是跳过"是否过期"的判断——锁、重读、轮换完全一致，
符合 spec "still under the per-server lock and rotation semantics"。失败时通过
backend 注入的回调把该 server 状态置 `auth-required`（spec 场景原文
"status reports needs-auth"，即既有 401 词汇，比 `degraded` 更准——工具仍
注册、其他上游不受影响，缺的只是授权）+ `remediationKind: "oauth"` +
`trellis mcp auth <name>` remediation（复用既有词汇，不发明新状态枚举），随后
再抛出——SDK 会把该异常原样透传给本次调用（已用真实 SDK 钉死），调用方立即
拿到带 remediation 的错误，正是 dead-grant 场景想要的结果。

### D5: 提前刷新窗口 5 分钟，只在 gateway 请求路径加宽

`token()` 调 `ensureFreshToken(..., { skewMs: 300_000 })`；`store.ts` 默认 60s
不动，`mcp auth`/`mcp renew` 语义保持。理由：分钟级窗口才能保证"过了新鲜度
检查的请求不会带着中途死亡的 token 飞完"（spec 要求），而其他调用方没有这个
中途飞行问题。

### D6: 无内存缓存，每请求读 token 文件

`readToken` 是小 JSON 的同步读，成本相对网络请求可忽略。加 TTL 缓存的收益
只有微优化，代价是破坏"跨进程写盘下一请求生效"这一硬约束（用户明确要求
零重启即时生效）。不做缓存。

### D7: `authProvider` 作为 `connectHttp`/`connectSse` 的可选参数穿透

`mcpConnect.ts` 定位是 consumer-agnostic 的传输层模块，不引入 homeDir/server
概念；它只接受一个已构造好的 `AuthProvider` 对象（如同现在接受 `clientInfo`）。
构造逻辑（闭包捕获 homeDir + name + 失败回调）留在 `gatewayBackend.addUpstream`，
`withOAuthHeader` 命中时创建并下传。

## Risks / Trade-offs

- [SDK `onUnauthorized` 抛异常时是否仍重试，行为未从文档完全确认] → 实现期
  用真实 SDK + 本地 HTTP MCP 测试服务器钉死两种分支（resolve / throw）的实际
  行为，测试即契约；两种结果都满足 spec（要么带 remediation 失败，要么重试后
  失败）。
- [每请求同步读文件在高 QPS 下的开销] → 网关场景单 Agent 会话的调用频率远
  低于使 readFileSync 成为瓶颈的量级；若未来出现热点，加"仅在锁内刷新时
  失效"的进程内缓存即可，不影响行为契约。
- [401 强刷在 token 实际有效但服务端误判 401 的 provider 上引发多余刷新] →
  轮换语义下多刷一次的代价是多一次 token endpoint 往返 + 旧 token 作废，
  不产生错误状态；可接受。
- [回滚] → 纯运行时行为增量，无 schema/配置迁移；revert 即回到现状，token
  文件格式不变，无需用户动作。

## Migration Plan

1. 实现按 tasks.md 顺序落地，全程 `npm test` + typecheck 门禁。
2. 发布为普通版本升级（无破坏性）；已运行的旧 gateway 进程自然终结于所属
   会话，无灰度需求。
3. 回滚：revert 提交或降级安装；存储与配置零迁移。

## Open Questions

- ~~SDK 在 `onUnauthorized` 抛出异常时的精确行为~~ **已由实现期测试钉死**：
  异常原样透传给本次调用（`RefreshError` 不被包装、不吞掉、不挂起），
  transport 不被毒化——重新授权后同一 client 的下一请求即恢复。契约见
  `test/unit/gatewayOauthRuntime.test.ts` "a throwing onUnauthorized"。
