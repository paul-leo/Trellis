# Proposal

## Why

统一代理后，agent 无法从工具名判断它属于哪个原始 MCP server：现有的
“保短”命名规则（唯一且 >12 字符的工具保留原名）让 `browser_click`
这类名字不带来源信息，agent 选工具和排障时都要猜。同时 Trellis 托管
OAuth 授权（sentry/supabase/morphix 的 `owner: trellis`）让网关成为
授权瓶颈：凭据续期、per-server 超时、claude.ai connector 差异都压在
网关一条链上，而 agent 原生 OAuth 能力早已可用。

## What Changes

- **BREAKING** Gateway 暴露的上游工具名全量加原始 server 前缀
  （`server__tool`），移除“唯一长名保留原名”的豁免；64 字符上限、
  确定性冲突分配、路由正确性保证保留。
- **BREAKING** 删除 `short-tool-source-prefix` capability：其
  “短名加前缀”规则被全量前缀完全覆盖，不再独立存在。
- Gateway 转售工具时在 description 注入来源说明（如
  `Source: <server>`），agent 不读名字也能确认归属。
- 保留 `mcp_status` 健康检查工具及现有网关运维面。
- OAuth server 默认原生直连投递（复用现有 `owner` 语义：缺省即
  agent-owned；`owner: trellis` 保持显式 opt-in 托管）。本 change
  不含 schema 改动；配套的本地 canonical 配置翻转
  （sentry/supabase/morphix → agent-owned）属于本次治理的实施动作，
  记录在 tasks 中。
- Trellis 内置 Runtime 工具维持紧凑命名（`memory_search` 等），
  不受上游前缀规则影响。

## Capabilities

### New Capabilities
（无 —— 行为变化全部落在现有 capability 的 requirement 修订上。）

### Modified Capabilities
- `mcp-tool-name-preservation`: “保留唯一工具原名”与“仅冲突加前缀”
  两条 requirement 改为“全量加 server 前缀”；确定性冲突分配保留。
- `short-tool-source-prefix`: 整个 capability 移除
  （`## REMOVED Requirements`），被全量前缀覆盖。
- `mcp-gateway-hosting`: 新增 requirement——gateway 转售工具的
  metadata（description） SHALL 标注上游来源 server；现有
  “工具带 server 前缀聚合并正确路由”的 requirement 与新规则一致，
  无需改写。

## Impact

- **代码**: `src/lib/mcpToolRegistry.ts`（命名分配规则）、
  `src/lib/gatewayBackend.ts`（description 注入）、gateway 相关单测。
- **Spec**: 上述 3 个 capability 的 delta；归档时主 specs 同步更新。
- **配置（治理动作，随本 change 实施）**: 本地
  `~/.trellis/mcp/servers.yaml` 中 sentry/supabase/morphix 的
  `owner: trellis` → 移除（回到 agent-owned 默认）；
  `~/.claude.json` 清理非托管重复/坏条目（mcp-router、tanka 直连、
  harness-solo/chrome-devtools 与 sentry/figma 的重复直连）。
- **使用方**: 所有 gateway 消费 agent 看到的工具名变化
  （`browser_click` → `obscura__browser_click` 等），
  需同步检查交付到各 agent 的 instructions/skill 文档中是否有
  硬编码旧工具名。
- **不动**: `mcp-auth-routing-policy`（owner 语义已满足需求）、
  `agent-tool-name-presentation`（内置工具命名不受影响）、
  `mcp_status` 工具。
