# Tasks

## 1. M1：检测、失败态与错误归因（独立可验收）

- [x] 1.1 扩展 `test/unit/gatewayOauthRuntime.test.ts` 的 loopback fake server：
  initialize 响应下发 `Mcp-Session-Id`；非 initialize 请求校验该 header，未知
  session 回 `404 + {"jsonrpc":"2.0","error":{"code":-32001,"message":"Session
  not found"},"id":null}`；新增"清空服务端 session store"注入函数（模拟上游重启）。
  （实现时核实：`server/discover` 属于预会话握手，与 initialize 一同豁免校验。）
- [x] 1.2 新增会话失效检测函数（design D1 判据）：`SdkHttpError && status===404 &&
  /session/i` 或 `ProtocolError && code===-32000 && /session/i`；单元测试覆盖两类
  判据与排除项（401、403/-32000、非 session 的 404 均不命中）。
  （实施备注：真机验证发现 400 + -32000 session body 也走 SdkHttpError 路径且被
  404 门漏检，已按 design 预留路径放宽为"非 401/403 且 /session/i"。）
- [x] 1.3 `LocalBackend.callTool` 改为先 `registry.resolve` 取 `serverName` 再调用；
  upstream 抛错包装为带 server 名的错误（保留原 message）。
- [x] 1.4 检测到会话失效时写入失败终态：`requiresSessionRestart: true`、remediation
  提示重启 agent 会话；状态不得停留 `ready`。
- [x] 1.5 M1 测试：会话失效注入后调用返回带 server 名的错误、状态非 ready 且
  `requiresSessionRestart`；其他上游工具不受影响。（按评审修订并入 3.4 的
  "恢复失败"形态覆盖。）

## 2. M2：自动恢复

- [x] 2.1 `LocalBackend` 持久保存 per-upstream `{ spec, options }`（`addUpstream`
  不再丢弃）。
- [x] 2.2 `McpToolRegistry.replace(serverName, upstream, tools)`：删除该 server 全部
  candidates 后 rebuild；单元测试覆盖工具集变化与碰撞重排。
- [x] 2.3 `UpstreamResources` 替换时清理该 source 的陈旧 `files` 路由（`removeSource`）。
- [x] 2.4 per-server single-flight 重连：`Map<serverName, Promise>`；恢复 = 重跑
  `addUpstream(replaceOf=旧client)`，**新 client 就绪后才关旧**（close-after-success，
  见 design D2 修订）；等待中并发调用 await 后重试一次；重连超时复用 `connectTimeoutMs`。
- [x] 2.5 冷却期（`SESSION_RECOVERY_COOLDOWN_MS = 30_000`）：恢复失败或重试再失败
  进入冷却，冷却期内调用直接失败（带 server 名 + 重启提示），不自动重连。
- [x] 2.6 状态机：恢复中 `reconnecting`（`UpstreamStatusKind` 新增值）；恢复成功
  回 `ready`；失败按 design D4 落终态；任何路径不停假 `ready`。
- [x] 2.7 OAuth 组合：重连复用 `addUpstream`（继承 OAuth header/authProvider）；在
  新 authProvider 处加注释说明 `lastIssued` 归零只多 rotate 一次、由锁内重读兜底。

## 3. 行为验证（真实 SDK + loopback）

- [x] 3.1 会话失效 → 调用透明恢复（agent 无感，`initializeCount === 2`）。
- [x] 3.2 并发调用只重连一次，全部重试成功。
- [x] 3.3 恢复后复用新 session，不再多余 initialize。
- [x] 3.4 重连失败（server 持续下线）→ unavailable + `requiresSessionRestart`，
  他 server 不受影响（隔离不变量）。
- [x] 3.5 `403 + -32000` 不触发重连（同 client 继续服务；状态写入沿用既有
  "调用错误不改 status"行为）。
- [x] 3.6 OAuth server 重连：initialize 带 Bearer，后续 401 路径仍正常。
- [x] 3.7 工具集变化：重连后 `tools/list` 反映新表，旧 exposed 名按确定性规则解析。
- [x] 3.8 401 强刷路径与重连路径共存不互扰（先 401 后 session 失效、反向各一例）。

## 4. 收尾

- [x] 4.1 全量 `npm test`、`npm run typecheck`、`npm run build` 通过。
- [x] 4.2 `openspec validate "trellis-mcp-gateway-session-recovery" --strict` 通过。
- [x] 4.3 release notes（docs/releases/v0.19.0.md）与 version bump（0.18.0 →
  0.19.0）。真机验证先行：用 dist/cli.js 真实进程 + 可控 session 的本地上游跑通
  13 项检查，并据其发现放宽 D1 判据（404 门 → 非 401/403 门）。harness 在
  /tmp/trellis-session-verify/{upstream.mjs,run-verify.mjs}（临时目录，未入库）。
