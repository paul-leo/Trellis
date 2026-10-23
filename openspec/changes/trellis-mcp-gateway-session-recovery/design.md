# Design

## Context（已核实，含代码位置）

### 错误传播链

```
上游 HTTP server 重启/TTL/LB 切换
  → 网关 client 持旧 Mcp-Session-Id
  → SDK send(): server 返回非 401/403/特殊 400
    → throw SdkHttpError(ClientHttpNotImplemented, "Error POSTing to endpoint: <body>",
      { status, statusText, text })   client/dist/index.mjs:5789
  → LocalBackend.callTool → McpToolRegistry.callTool 原样上抛
  → BuiltinRegistry.callTool catch → providerError("upstream", err)
    → 用户所见 "trellis-mcp-runtime: provider "upstream" failed: …"
```

### 已核实的 SDK 行为（client 2.3.1，dist/index.mjs）

- `Mcp-Session-Id` 只在 initialize 握手成功时设置（:5738 `isHandshake && response.ok`），
  只在 `terminate()` 清除（:5852）。**无 session 失效→重新 initialize 分支**。
- 非 401/403 的错误响应一律走 :5789 抛 `SdkHttpError`，带 `status` getter 与
  原始 body `text`。错误对象从 transport 原样上抛到调用方，无包装。
- `ProtocolError` 对应的是 **HTTP 200 + JSON-RPC error body** 的信封错误；
  真机验证（2026-10-23）表明 400 + -32000 session body 走的仍是普通
  `SdkHttpError` 路径（"Error POSTing to endpoint: …" 原样包住 body），
  信封解析在该形态下不发生。

### 已核实的官方 server 惯例（server dist/index.mjs）

- session 失效 = **HTTP 404 + JSON-RPC -32001 "Session not found"**（:487,:636,:741,:762）。
- 鉴权拒绝 = **HTTP 403 + JSON-RPC -32000**（:470,:478）——这正是原方案
  "裸匹配 -32000" 会误吞认证错误的根源。
- 真机观察到的是第三种措辞：`-32000 "MCP session no longer exists; initialize a new
  session"`（具体上游实现自定义）。该错误经 :5789 的 SdkHttpError 路径上抛，说明其
  HTTP status 不是 401/403；真机验证进一步显示 400 body 也走这条路，而判据无法预知
  各上游选用的 status，故 SdkHttpError 分支的 status 门取"非 401/403"。

### 重试安全性（已核实）

session 校验发生在 HTTP 层、JSON-RPC dispatch 之前（server :636 等处先于请求处理），
收到 session 失效响应说明**上游未执行该调用**——重试无重复副作用。`listTools` /
`listResources` 幂等；`callTool` 同样安全；调用路径全部是有 id 的 request，无通知类消息。

### OAuth 交互（已核实不打架）

重连建新 client 与新 `trellisAuthProvider` 闭包，`lastIssued` 归零。后果：新 client
首次 401 时 `forceRefresh(previousAccessToken=undefined)` 跳过"他人已刷新"护栏，多
rotate 一次 grant——`withServerLock` + 锁内 re-read（oauth/refresh.ts:101）保证从最新
token 出发，**非正确性问题**，加注释说明即可。重连复用 `addUpstream`，自动继承
`withOAuthHeader`（含 resourceUrl 校验）、authProvider、mcp-router 0-tool degraded 特例。

### 现状代码事实

- `LocalBackend.addUpstream`（gatewayBackend.ts:120-194）连接后丢弃 spec/options；
  `statuses` 仅在连接路径写入（:122/:132/:156/:170/:180/:192/:237/:254），无任何
  mid-session 更新 → 假 ready。
- `McpToolRegistry.add`（mcpToolRegistry.ts:181）向 `candidates` 追加后 `rebuild()`，
  无按 server 删除；`AddResult.skipped` 恒为 `[]`（:185），gatewayBackend.ts:176-178
  的 collide 警告是死代码——replace 不要建立在 skipped 语义上。
- `UpstreamResources.add` 用 `Map.set`（upstreamResources.ts:52）本来就覆盖；真正缺的
  是替换时清理该 source 的 `files` 路由（:73、:105 只增不减，陈旧路由会以 identity
  mismatch 打到新 client）。
- `UpstreamStatusKind` 仅 gatewayBackend.ts:53 一处定义；消费方
  `mcpStatusProvider.ts:62`、`runtimeControlProvider.ts:153` 是 JSON 直通 +
  `!== "ready"` 过滤，新增 `reconnecting` 值安全。
- `LocalBackend.callTool`（:200-202）直接委托 `registry.callTool`，拿不到 serverName
  ——检测与单飞都要求先 `registry.resolve(name)`。
- `connectServer`（mcpConnect.ts）自带 `connectTimeoutMs`（默认 10s）与失败清理
  （`connectWithCleanup`），重连直接复用，无新超时机制。
- 无死锁环：registry 无锁（JS 单线程）；OAuth per-server 文件锁只在
  `ensureFreshToken`/`forceRefresh` 内短暂持有，`connectServer` 的 initialize 经
  authProvider `token()` 走一次 `ensureFreshToken`，与 401 路径共用同一把锁，序列化
  后各自短暂持有。

## Goals / Non-Goals

- **Goals**：会话失效自动恢复（per-server、single-flight、冷却、重试一次）；状态
  诚实（reconnecting 过渡、失败终态 requiresSessionRestart）；错误带 server 名。
- **Non-Goals**：`listChanged` 通知；跨进程网关协调；stdio 上游的自动重启（其进程
  由 spawn 管理，崩溃已有 connect 失败隔离）；退避策略调优（固定冷却即可）。

## Decisions

### D1. 检测判据 = 错误类型 + 状态码/错误码 + 语义词

```
isSessionInvalidation(err):
  SdkHttpError 且 status ≠ 401 且 status ≠ 403 且 /session/i.test(message)
  或 ProtocolError 且 code === -32000 且 /session/i.test(message)
```

status 门最初按 `=== 404` 实现；真机验证（2026-10-23，真实 dist/cli.js 进程 +
可控 session 的本地上游）复现出 400 + -32000 session body 同样走 SdkHttpError
路径且 404 门漏检，遂按 design 预留的放宽路径改为"非 401/403"。误报面（非鉴权
status 且 body 恰好含 "session"）的代价是一次幂等安全的重连+重试，可接受。
**替代方案否决记录**：裸文本匹配 `-32000` 漏掉官方 404/-32001、误吞 403/-32000
认证错误——评审 M1；`status === 404` 漏检自定义上游的 400/5xx session 响应——
真机 S5。

### D2. 恢复 = 重跑 addUpstream，成功后才关旧（close-after-success）

`LocalBackend` 持久保存 per-upstream `{ spec, options }`。恢复时把 `replaceOf=旧client`
传给原 `addUpstream`：resources `removeSource` 清理陈旧路由 → registry `replace` →
重跑启动路径 → **新 client 注册成功后才 `closeClient(replaceOf)`**。这比另写重建路径
好：OAuth header、authProvider、mcp-router 特例、状态写入全部继承。

先关旧再重连（初版措辞，评审 M2 的"不关会泄漏"）与 D3 矛盾：旧 client 一旦关闭，
失败恢复后的后续错误是 "not connected" 而非 session 错误，D3 的"冷却过期后可再触发"
永不成立。故改为 close-after-success：恢复失败时旧 client 保留，其 session 错误在
冷却过期后重新触发恢复（连接既不泄漏也不孤儿化——成功路径由 addUpstream 尾部关闭，
失败路径原样保留）。并发 straggler 从旧 client 收到的迟到 session 错误由 callTool 的
staleness 守卫处理（`connected.get(name) !== target.upstream` 时跳过恢复，直接对当前
注册重试一次），不会启动第二次重连。

### D3. 单飞与重入 = per-server Promise + 冷却

`Map<serverName, Promise<ReconnectResult>>`：恢复期间新调用 `await` 同一 promise 后
重试一次。冷却：恢复失败（重连失败或重试再失败）后进入固定冷却窗（`SESSION_RECOVERY_
COOLDOWN_MS = 30_000`），冷却期内该 server 的调用直接失败（错误带 server 名 + 提示
重启 agent 会话），不自动重连；冷却过期后下一次会话失效错误可再触发。重连超时即
`connectTimeoutMs`，不新增机制。

### D4. 终态语义（评审 M5）

- 重连中：status `reconnecting`；
- 重连失败：`failureStatus`（正确分类 auth/timeout/unavailable）+ `requiresSessionRestart: true`；
- 重连成功但重试再失败：同上失败态 + 进入冷却，**不标 ready**；
- 检测到会话失效但恢复被冷却拦截：保持现有失败态（不回到 ready）。
任何路径都不允许停在假 ready。

### D5. registry replace（评审 M4 附带）

`replace(serverName, upstream, tools)`：过滤掉该 server 全部旧 candidates → 追加新
candidates → `rebuild()`。不复用 `skipped`（恒空）。exposed-name 全局重排是既有
`allocateExposedToolNames` 语义：其他 server 的工具名可能因碰撞解决而变化，本期接受
"旧名失效到下次 tools/list"，写入 spec 场景，不做 listChanged。

### D6. 错误带 server 名（评审 M4）

`LocalBackend.callTool` 改为先 `registry.resolve(name)` 取 `{ serverName, upstream }`，
再调用 upstream；upstream 抛错时包装为带 server 名的错误再上抛（保留原 message）。
`BuiltinRegistry`（mcpRuntime.ts）的 providerError 维持不变——网关层已带名。

## Risks / Trade-offs

- **工具名漂移**（接受，spec 场景明示）：重连后其他 server 工具的 exposed 名可能变化。
- **冷却期内硬失败**（接受）：30s 内该 server 调用直接报"需重启 agent 会话"，诚实但
  不优雅；后续可改指数退避。
- **检测漏检**（有界）：判据外的自定义措辞不触发重连，但 M1 的失败态 + server 名
  保证不再是假 ready + 匿名错误。
- **lastIssued 归零多 rotate 一次**（接受，加注释）。

## Open Questions

- ~~真机那个 `-32000` 上游的 HTTP status 尚未确认~~ 已解决（2026-10-23 真机验证）：
  status 无需再核对——判据放宽为"非 401/403 且 /session/i"后对任意非鉴权 status
  均命中，官方 404/-32001、真机 -32000（404 与 400 两种形态）、HTTP-200 信封错误
  三路全部实测恢复。
- 冷却窗 30s 是首版定值；等真机数据再调。

## Milestones

- **M1（独立可验收）**：检测函数 + 会话失效落失败态（requiresSessionRestart）+
  错误带 server 名 + fake server 支持发/校验 session id。此时无自动恢复，但不再
  假 ready、错误可定位。
- **M2**：single-flight 重连 + registry/resources replace + 重试一次 + 冷却 +
  reconnecting 状态。
