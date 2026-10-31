# Tasks

## 1. 命名规则改造（registry 层）

- [x] 1.1 修改 `allocateExposedToolNames`：以 per-candidate `alwaysPrefix` 实现全量前缀（registry 的所有候选置 true；内置 Runtime 工具走原逻辑保持紧凑名）；保留 64 字符截断、确定性排序和 `__N` 冲突序号。验证：`mcpToolRegistry.test.ts` 19/19 绿，新增用例覆盖“唯一长名也带前缀”。
- [x] 1.2 更新受影响的既有单测。验证：`npm test` 全量 1268/1268 通过。

## 2. Description 来源注入（backend 层）

- [x] 2.1 `McpToolRegistry.listTools` 在 description 末尾追加 `Source: <server>` 行；上游 description 为空时只写来源行；不改动上游原文。验证：新增单测覆盖“追加不覆盖原文”“空 description”“唯一长名前缀”三种情况，19/19 绿。
- [x] 2.2 内置 Runtime 工具不进入前缀/注入逻辑（`BuiltinRegistry` 无需改动：上游工具经 `UpstreamProvider` 带已暴露名进入，`__` 判定直通；内置工具维持 `agent-tool-name-presentation` 紧凑名）。验证：相关测试无变化通过，全量 1268/1268 绿。

## 3. 文档与硬编码工具名清理

- [x] 3.1 rg 全仓搜索旧裸暴露名。验证：仅 `trellis-runtime` SKILL.md 与 getting-started.md 引用 `mcp_status`/`memory_search`/`skills_read` 等内置工具名（不受前缀规则影响，无需改）；无上游工具裸名残留。
- [x] 3.2 运行完整校验。验证：`npm test` 1268/1268、`tsc --noEmit`、build（含 pi-bridge bundle）全部通过。

## 4. 本地 MCP 配置治理（需用户现场确认）

- [x] 4.1 备份：`~/.trellis/mcp/servers.yaml`、`~/.claude.json` 复制到 `~/.trellis/backups/mcp-governance-20261031-115538/`（claude.json 权限 600，含 MANIFEST + sha256）。验证：备份文件存在且含清单。
- [x] 4.2 翻转 servers.yaml：sentry / supabase / morphix 移除 `owner: trellis`；morphix-air-tasks 维持 `enabled: false`。验证：`trellis mcp list --json` 显示四个 OAuth server（figma 原本就是）均为 agent-owned。
- [x] 4.3 dry-run 审阅后经用户确认执行真实 sync。验证：sync 输出与 dry-run 一致——supabase/morphix 写入 claude.json，sentry/supabase/morphix 写入 codex，sentry 写入 kiro/pi/kimi-code/zcode，0 conflict。
- [x] 4.4 非托管条目治理（按用户“尽可能收编进 Trellis”目标调整方案）：mcp-router 因 MCPR_TOKEN 缺失（shell profile 与环境均未设置，直连 fetch failed）无法直接收编，以 `enabled: false` 收编进 canonical servers.yaml 留档；harness-solo / chrome-devtools / tanka 直连（与网关重复，tanka 直连 ENOENT）及 mcp-router 直连从 `~/.claude.json` 移除；sentry/figma 直连被 sync 收编为托管原生条目。验证：删后 `mcpServers` 仅剩 `sentry`/`figma`/`supabase`/`morphix`（OAuth 原生）+ `trellis`（网关）。残留风险：若 mirasim 宿主注入 harness-solo/chrome-devtools，重启后可能再现，属宿主行为不在 Trellis 范围。
- [x] 4.5 morphix 项目治理：`/Users/pengzai/www/morphix/.mcp.json`（仅含未启用的 `morphix-oauth-dev`，git 未跟踪）整文件移除，消除 dev 端点与生产 morphix 的干扰。验证：文件已删除，morphix 仓库无 git 变动。
- [ ] 4.6 新会话验证：`mcp_status` 显示网关只聚合非 OAuth server；OAuth server 以原生条目出现且凭据状态可见；工具名全量带 `server__` 前缀。验证：实测输出与 spec 场景一致。

## 5. 归档

- [ ] 5.1 实现与治理全部完成后，按 OpenSpec 流程归档本 change：主 specs 应用 delta（name-preservation 更新、short-tool-source-prefix 删除、gateway-hosting 增补），补充 spec-test-mapping。验证：`openspec validate` 通过，archive 目录结构正确。
