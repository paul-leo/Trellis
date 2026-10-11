# Proposal

## Why

Trellis 今天只托管全局层（`~/.trellis/`），但六个受管 Agent 中五个原生支持项目级配置（Claude Code 的 `.mcp.json`/`.claude/skills/`、Codex 的 `.codex/config.toml`/`.agents/skills/`、Kiro 的 `.kiro/`、pi 的 `.pi/`、Kimi Code 的 `.kimi-code/`），且行业共识是"项目覆盖全局、配置随 repo 走、团队共享"。用户需要在某个目录下托管该项目专属的 MCP、skills 和指令，让配置可以提交进 repo、随 clone 分发，而不是只能在每台机器的全局层手工重复配置。调研已于 2026-10-11 完成（六 Agent 项目级能力矩阵 + 行业扫描 + 仓库约束盘点），结论见 design。

## What Changes

- 新增**项目层 canonical source**：`<workspace>/.agents/`（对齐 `.agents` Protocol 草案的两层模型），内含 `config.json`（项目级 MCP 声明，带 schema 版本号）、`AGENTS.md`（项目级指令）、`skills/<name>/SKILL.md`（项目级 skills）。项目层可提交 git；**永不存放 secret 值**，只允许 `${VAR}` 引用，值继续由全局 secret store 独占管理。
- `loadCanonicalSource` 支持可选 workspace root：向上从 cwd 发现最近的 `.agents/` 目录；加载后与全局层按"同 ID workspace 赢、指令按层拼接、`enabled: false` 墓碑禁用"的语义合并，并记录每条目的来源层（provenance）。**BREAKING（规格级）**：修订 `canonical-source-loading` 中"SHALL NOT 读取项目本地目录"的要求，改为"默认全局唯一，显式 workspace 场景下加载项目层"。
- **层级保留式投递**：全局内容照旧写全局路径，项目内容写各 Agent 的项目级原生路径（Claude `.mcp.json`/`.claude/skills/`、Codex `.codex/config.toml`、Kiro `.kiro/`、pi `.pi/mcp.json`、Kimi `.kimi-code/`、zcode `zcode.json`；`.agents/skills/` 对 Codex/pi/Kimi 是零适配直读），最终 layering 交给 Agent 原生 precedence，Trellis 不重复合并。渲染产物带 managed 标记、**提交进 repo**，供未安装 Trellis 的协作者直接使用。
- `trellis sync` 在含 `.agents/` 的 repo 内自动纳入项目层（`--global-only` 可关），新增 `--check` 模式：只比对不写入、有漂移即非零退出，供 pre-commit/CI 做新鲜度校验。
- `trellis init --workspace` 脚手架 `.agents/`；`trellis mcp add` / `trellis skill add` 支持 `--workspace` 写入项目层；`trellis status` / `trellis doctor` 显示每条目的来源层与被遮蔽的全局条目。
- 新增 `trellis migrate --workspace`：扫描 repo 内六 Agent 的既有项目级配置，出迁移计划（冲突裁决、与全局层去重、个人 local 文件跳过），**拦截明文 secret**（转 `${VAR}` 引用、值入全局 store、已提交过的提示轮换），备份放到 repo 外的 `~/.trellis/backups/`，确认后写入 `.agents/` 并渲染。
- **明确不做**：项目级 memory 托管（各 Agent 语义差异最大，延后）；项目级 MCP 走 gateway/hub（项目层一律 Agent 原生直连，OAuth 走 agent-owned 登录）；代答各 Agent 的 trust 首次批准提示；项目级 `.env` 值来源（用户明确排除）；Windows symlink 依赖（项目层 skills 投递用复制不用符号链接）。

## Capabilities

### New Capabilities

- `workspace-scope`: 项目层 canonical source 的发现（从 cwd 向上定位 `.agents/`）、加载、schema 版本检查、与全局层的合并语义（同 ID workspace 赢、墓碑禁用、指令拼接、provenance 记录），以及 secrets/trust 边界（policy 全局唯一、项目层只许 `${VAR}` 引用、Trellis 不代答 trust）。
- `workspace-delivery`: 项目层内容到六 Agent 项目级原生路径的渲染（含 `.agents/skills/` 零适配直读面）、managed 标记与漂移检测、渲染产物的 repo 提交语义、`trellis sync --check` 新鲜度校验、状态/诊断的层归因。
- `workspace-migration`: `trellis migrate --workspace` 的既有配置扫描、迁移计划、冲突裁决、全局去重、明文 secret 拦截与轮换提示、repo 外备份与回滚。

### Modified Capabilities

- `canonical-source-loading`: 修订 "Global-only canonical source loading" 要求——解除"SHALL NOT 读取项目本地目录 / SHALL NOT 接受 root 参数"的禁令，改为默认全局、显式 workspace root 时加载 `.agents/` 项目层并合并；同时拆分 homeDir 的"canonical 定位"与"用户主目录"双职语义。

## Impact

- `src/core/canonical.ts`：`loadCanonicalSource` 签名演进为可选 `{ homeDir, workspaceDir }`（默认值保持旧行为，约 40 个现有调用点零改动）；新增 workspace 发现与项目层加载/合并；`CanonicalSource` 增加来源层 provenance。
- 新增 `src/lib/workspace.ts`（发现、`.agents/config.json` 加载、schema 版本）与 `src/lib/workspaceMerge.ts`（合并 + provenance）。
- `src/adapters/`（claude-code、codex、kiro、pi、kimi-code、zcode、jsonMcp、piMcp）：新增各 Agent 项目级渲染目标；skills 项目层投递为复制（非符号链接）。
- `src/commands/sync.ts` / `src/lib/syncArgs.ts`：workspace 自动发现、`--check`、`--global-only`、层归因摘要。
- `src/commands/init.ts`、`src/commands/mcp.ts`、`src/commands/skill.ts`：`--workspace` 目标层。
- `src/commands/migrate.ts`：`--workspace` 迁移流程；`src/lib/backup.ts` 复用（备份到 `~/.trellis/backups/`，repo 外）。
- `src/commands/doctor.ts`：项目层状态、缺口 secrets、遮蔽报告。
- 文档：`docs/architecture.md`（Global vs. workspace scope 一节改写）、`docs/getting-started.md`、`docs/roadmap.md`；`openspec/specs/canonical-source-loading/spec.md` 随归档修订。
- 不影响：gateway/hub 运行时（保持全局唯一）、secret store 格式、现有全局 sync 行为（默认零变化）、pi bridge 退役计划。
