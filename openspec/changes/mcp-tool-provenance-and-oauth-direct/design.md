# Design

## Context

- 命名分配集中在 `src/lib/mcpToolRegistry.ts` 的
  `allocateExposedToolNames`：当前规则是“唯一且 >12 字符、或已含来源
  限定则保留原名，否则加 `server__` 前缀”。`short-tool-source-prefix`
  spec 固化过这条 12 字符规则。
- description 注入点在 gateway 转售工具处：registry 已持有
  server→tool 的完整候选信息，backend 列出工具时即可改写 metadata。
- 内置 Runtime 工具（`trellis.memory.search` → `memory_search`）走
  `agent-tool-name-presentation` 的压缩路径，与上游聚合命名是两条
  独立机制，互不影响。
- OAuth 直连不需要 schema 变更：`mcp-auth-routing-policy` 已规定
  owner 缺省即 agent-owned、原生投递；`owner: trellis` 是唯一托管
  入口。本次只需翻转本地 canonical 配置并清掉 agent 侧非托管重复条目。

## Goals / Non-Goals

**Goals:**
- 任意 gateway 暴露的工具名都能直接读出所属 server。
- agent 不依赖名字也能从 description 确认来源。
- 本地 MCP 配置收敛为“Trellis 托管 + OAuth 原生直连”单轨。

**Non-Goals:**
- 不改 `mcp_status`、不改内置工具命名、不改 OAuth 分类 schema。
- 不动 `morphix-air-tasks` 的 `enabled: false` 状态（冷启动超时
  问题另行解决）。
- 不为 per-server 混合投递新增 route schema（OAuth 直连由分类推导，
  无需显式开关）。

## Decisions

### D1: 全量前缀在 registry 分配层实现，替换豁免分支
`allocateExposedToolNames` 中删除 `unique && length > 12` 和
`sourceQualified` 两个免前缀分支，所有上游候选统一走
`prefixedToolName`。已含 `__` 的“已限定名”也不再豁免——统一规则优先
于节省长度。64 字符截断 + hash、确定性排序、`__2` 序号分配全部保留。

*备选*：保留长度豁免、只给 description 注入。被否——用户明确要名字
本身可辨识，description 是增强而非替代。

### D2: description 注入用追加行，不改写上游原文
backend 列出工具时在 description 末尾追加 `Source: <server>` 行。
若上游 description 为空则只写来源行。不做语言润色、不删除上游内容，
避免破坏上游自带的调用说明。

*备选*：改写开头加 `[server]` 前缀。被否——开头插入会打断上游
描述的首句语义，部分 agent 只读前 N 字符。

### D3: 内置 Runtime 工具不进 registry 前缀逻辑
`trellis.*` 内置工具维持现有压缩命名（`memory_search`），gateway
聚合层对它们不加前缀、不加 Source 行（它们没有“上游 server”概念；
若未来要求标注，也应标注为 `trellis` 内置）。注意 pi-bridge 与
gateway 共用 `McpToolRegistry`，pi 消费的工具同样获得前缀与 Source
行——这是 D1“命名集中在共享 allocator”的必然结果，有意为之：pi
侧的 agent 同样需要来源可辨识。index.ts 里 description 缺失时的
fallback 因此成为防御性死代码，保留不改（接口仍声明 optional，
对未来行为变化是合法护栏）。

### D4: OAuth 直连靠分类推导，不加配置开关
`resolveGatewayUpstreams` 继续按现有语义排除 agent-owned OAuth；
实施时把 sentry/supabase/morphix 的 `owner: trellis` 从本地
servers.yaml 移除。这样 claude.json 等原生配置由 `trellis mcp sync`
直写 http oauth 条目，各 agent 自行走授权。保留
`trellis mcp auth/renew` 命令供仍选择 `owner: trellis` 的场景。

*备选*：新增 `delivery: direct|gateway` per-server 字段。被否——
现有 owner 语义已能表达，多一个开关只会产生第二种事实源。

## Risks / Trade-offs

- [工具名整体变长，token 消耗上升] → 一次性变化；前缀平均 8-12
  字符，且在 64 字符上限内截断保护。换来来源可辨识，用户已拍板。
- [instructions/skill 文档中硬编码旧裸名失效] → 实施时 rg 全仓
  `browser_click|memory_search` 等旧暴露名并更新；evolve 的 drift
  检测可长期兜底。
- [sentry 等翻成直连后，claude-code 需用户在 claude.ai connector
  设置里授权 sentry] → 治理步骤中显式提示；mcp_status 的 oauth
  段会继续报告各 server 凭据状态（含 agent-managed）。
- [非托管重复条目（mcp-router 等）删除后用户若仍需要] → 治理前
  备份 `~/.claude.json`；删除清单在 tasks 里逐项列出并经用户确认。

## Migration Plan

1. 实现代码改动 + 单测（registry 命名、description 注入）。
2. 全仓检查并更新硬编码旧工具名的文档/skill。
3. 本地治理：备份 → 翻 owner → `trellis mcp sync --dry-run` →
   真实 sync → 清理 claude.json 非托管条目 → 新会话验证
   `mcp_status` 与工具列表。
4. 回滚：git revert 代码；配置侧凭备份恢复 servers.yaml 与
  `~/.claude.json`。

## Open Questions

（无——OAuth 直连的授权提示、重复条目清单都在实施时现场确认。）
