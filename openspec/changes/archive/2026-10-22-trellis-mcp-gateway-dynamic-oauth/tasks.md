# Tasks

## 1. refresh 层扩展

- [x] 1.1 在 `src/lib/oauth/refresh.ts` 新增 `forceRefresh(homeDir, serverName, opts)`：`withServerLock` 内锁内重读（他方已刷新则直接返回现值）→ 否则 `performRefresh` → `writeToken`，与 `ensureFreshToken` 的区别仅是跳过过期判断。单测覆盖：未过期也强制刷新、他方已刷新时不重复、refresh token 轮换写回、刷新失败抛 `RefreshError`（携带 oauthError）
- [x] 1.2 补测 `ensureFreshToken` 对大 skew 的服从性（`skewMs: 300_000` 时剩余 4 分钟的 token 触发刷新、剩余 6 分钟不触发），确认参数路径无需改 `store.ts` 默认值

## 2. transport 层穿透

- [x] 2.1 `src/lib/mcpConnect.ts`：`connectHttp`/`connectSse`（及 `connectServer` 签名）接受可选 `authProvider` 参数并透传给 transport 构造选项；模块不引入 homeDir/server 概念。以单元测试 + typecheck 验证参数正确到达 transport（ spying 构造选项或借 3.2 的真实 transport 测试兜底）

## 3. gateway 集成

- [x] 3.1 `src/lib/gatewayBackend.ts` `addUpstream`：当 `withOAuthHeader` 实际附加了存储凭据（OAuth + owner:trellis + 无显式 Authorization + http/sse transport）时构造 `AuthProvider` 并下传——`token()` 调 `ensureFreshToken(..., { skewMs: 300_000 })`，刷新失败返回旧 token 不抛；`onUnauthorized` 调 `forceRefresh`，失败时经回调置 `statuses` 为 `degraded` + `remediationKind: "oauth"` + `trellis mcp auth <name>` remediation 后再抛。单测（fake fetchImpl）：token 刷新失败返回旧值、onUnauthorized 成功/失败两分支、canonical 显式 `Authorization` 时不构造 provider（显式优先回归）
- [x] 3.2 集成测试：真实 `StreamableHTTPClientTransport` + 本地 in-process HTTP MCP 测试服务器（可编程校验 token、可返回 401）。钉死 SDK 行为契约：`token()` 每请求被调用；401 → `onUnauthorized` → SDK 自动重试一次成功；`onUnauthorized` 抛出时调用方的可见结果（回答 design Open Question，两种结果断言其一）
- [x] 3.3 场景测试（对应 specs delta）：(a) 会话中途外部重授权——两次调用之间改写 token 文件，下一次调用用新 token 成功、无重连；(b) 会话寿命超过 token 寿命——token 进入 5 分钟窗口即预刷新并写盘后才发请求；(c) revoked-but-unexpired——服务端 401 后强刷重试对调用方透明

## 4. 验收

- [x] 4.1 死授权隔离验收：`invalid_grant` 时仅该 server 的调用失败且错误含 remediation，其他上游工具继续可用，`mcp_status` 快照显示 degraded + oauth remediation，无浏览器拉起
- [x] 4.2 全量门禁：`npm test`、typecheck、build 全绿；`openspec validate --strict --change trellis-mcp-gateway-dynamic-oauth` 通过；spec scenario 与测试用例对照无遗漏
