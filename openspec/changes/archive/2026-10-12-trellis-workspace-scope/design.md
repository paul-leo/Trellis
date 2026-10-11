# Design

## Context

见 proposal.md - Why。约束事实（2026-10-11 三方调研核实）：

- 仓库内：`canonical-source-loading` 规格有明文 SHALL NOT 禁止项目本地目录与 root 参数；`loadCanonicalSource(homeDir = homedir())`（src/core/canonical.ts:621）有约 40 个调用点全部透传 homeDir 字符串，且 homeDir 身兼两职——canonical root 定位（`trellisRoot(homeDir)`）与用户主目录语义（`loadSecretsPolicyYaml` 的 `~` 展开，src/core/canonical.ts:467-475）。
- 六 Agent 项目级能力（官方文档核实）：Claude Code（`.mcp.json`、`.claude/skills/`、`CLAUDE.md` 层级，local>project>user）、Codex（`.codex/config.toml` 信任门控、`.agents/skills/`、AGENTS.md 逐级）、Kiro（`.kiro/settings/mcp.json`、`.kiro/skills/`、`.kiro/steering/`，workspace 全维度优先）、pi（`.pi/mcp.json`+`.pi/skills/`+`.agents/skills/`，信任门控）、Kimi Code（`.kimi-code/{mcp.json,skills/,AGENTS.md}`+`.agents/skills/`，Project>User）、zcode（`zcode.json`/`.zcode/config.json`；MCP 同名冲突是**唯一反向**——用户级优先；本机 zcode 为非官方 CLI）。
- 行业：`.agents` Protocol 草案（DRAFT，无参考实现）定义 `~/.agents ← ./.agents` 两层、按 ID 合并、workspace 赢；secrets 一律 `${env:VAR}` 插值不入库；项目配置 trust 门控是 Codex/pi/Kimi/Claude 标配。

## Goals / Non-Goals

**Goals:**

- 项目层 canonical 随 repo 分发：clone 后未装 Trellis 的协作者直接可用（渲染产物入库），装了 Trellis 的 `sync` 重新接管。
- 全局层行为零变化：不进入含 `.agents/` 的 repo、或显式 `--global-only` 时，每个命令与今天完全一致。
- 复用现有 adapter/drift/备份机制，不为 workspace 造第二套写入管线。

**Non-Goals:**

- 项目级 memory 托管；项目级 gateway/hub 实例；代答 trust；项目级 `.env` 值来源；`.agents` Protocol 草案的完整实现（只借形状，不承诺兼容其 `defaults/config.json` 全 schema）；Windows 符号链接支持。

## Decisions

### D1. 项目层目录 = `<workspace>/.agents/`，不用 `.trellis/`

理由：(a) Codex/pi/Kimi 原生读 `.agents/skills/`——这三家的项目级 skills **零适配直读**，canonical 即交付物；(b) 对齐草案是 Trellis 既定立场（做首个实现比当第六个标准有杠杆）；(c) 没有 Agent 认识 `.trellis/`。备选 `.trellis/` 被否：全部六家都要适配转换，且自造封闭约定与 Trellis 的开放立场矛盾。

布局与格式：

```
<workspace>/.agents/
  config.json              # { "version": 1, "mcp": { "servers": { <name>: <canonical server 字段的 JSON 形> } } }
  AGENTS.md                # 项目级指令（可选）
  skills/<name>/SKILL.md   # 项目级 skills（可选，Agent Skills 标准格式，与全局 canonical 同形）
```

`config.json` 的 server 字段复用 `servers.yaml` 的 canonical 字段集（`transport`/`url`/`command`/`headers`/`env`/`staticEnv`/`envAliases`/`auth`/`agents`/`enabled` 等）的 JSON 形态，加载时走同一个校验器——不为项目层发明第二套 server schema。`version` 缺失视为 1；大于本版认识的值 → 报"请升级 Trellis"而非静默误读；未知顶层 key → warning 不报错（向前兼容）。

### D2. 发现与加载：cwd 向上找 `.agents/`，显式传入而非全局状态

- `findWorkspaceRoot(cwd): string | null`：从 cwd 逐级向上，第一个含 `.agents/` 的目录即 workspace root；找不到返回 null（纯全局行为）。不跨文件系统边界、不要求 git repo（`.agents/` 存在本身就是标记，git root 只是常见情形）。
- `loadCanonicalSource` 签名演进：`loadCanonicalSource(options?: { homeDir?: string; workspaceDir?: string | null })`，默认 `{ homeDir: homedir(), workspaceDir: null }` ——约 40 个现有调用点零改动（旧签名 `loadCanonicalSource(homeDir: string)` 由重载兼容，内部归一到 options）。homeDir 的两职就此拆开：canonical 全局 root 与 secrets `~` 展开都只看 homeDir；workspaceDir 只定位项目层。
- **workspace 感知是命令级选择**：`sync`/`migrate`/`doctor`/`status`/`mcp add`/`skill add`/`init` 传 `workspaceDir: findWorkspaceRoot(process.cwd())`；gateway/mcp-runtime 等常驻进程**保持全局唯一**（v1 不做项目级 gateway，见 D6）。
- 返回的 `CanonicalSource` 增加 `provenance: Map<条目ID, "global" | "workspace">` 与被墓碑禁用/遮蔽的条目清单，供 doctor/status 层归因。

### D3. 合并语义：同 ID workspace 赢 + 墓碑 + 指令拼接

- MCP/skills：同 ID 项目层覆盖全局层（5/6 Agent 原生 precedence 同向；zcode MCP 反向，见 Risks）。项目层 `{ "enabled": false }` 是**墓碑**——显式禁用某全局条目，不渲染到任何项目级文件。
- 指令：不合并内容——全局层已写全局路径、Agent 原生拼接（Claude/Codex/pi/Kimi 都是"越近越后"）。Trellis 只把项目层 `AGENTS.md` 投递到各 Agent 项目级指令路径。"拼接语义"只存在于 doctor/status 的**有效视图**计算中。
- 备选"由 Trellis 合并后写项目文件"被否：与 Agent 原生 layering 重复、遮蔽关系在用户手改全局后失真，且违反 D4 的最小写入原则。

### D4. 投递：层级保留，Agent 原生 layering 兜底

全局内容照旧只写全局路径；项目层只写项目级路径：

| 维度 | Trellis 需要渲染的 | 零适配（Agent 直读 `.agents/`） |
|---|---|---|
| Skills | Claude → `.claude/skills/<name>/`（**复制**，见 D5）；Kiro → `.kiro/skills/<name>/`（复制）；zcode → Runtime 投递（沿用现有 SkillProvider，项目层 skills 纳入其清单） | Codex / pi / Kimi |
| MCP | Claude `.mcp.json`、Codex `.codex/config.toml`、Kiro `.kiro/settings/mcp.json`、pi `.pi/mcp.json`、Kimi `.kimi-code/mcp.json`、zcode `zcode.json` | — |
| 指令 | Kiro → `.kiro/steering/trellis-workspace.md`；Claude → 不写根 `CLAUDE.md`（几乎必是用户文件，撞上即报提示走 migrate），项目指令经 `.agents/AGENTS.md` 由 AGENTS.md 系 Agent 直读 | Codex / pi / Kimi（读 repo 内 AGENTS.md 链） |

写入纪律沿用全局 sync 的既有语义：managed 标记识别 Trellis 产物、无标记的既有文件拒绝覆盖（报提示、引导 migrate）、deepEqual 判漂移、同一 backup transaction。

### D5. 项目层 skills 用复制，不用符号链接

全局层投递是 symlink（`~/.claude/skills/x → ~/.trellis/skills/x`），项目层改复制。理由：(a) 渲染产物要入库分发（D7），Windows 上 git symlink 默认不可用且需开发者权限；(b) 复制后无 Trellis 的协作者拿到的是实体文件；(c) skills 体积小，复制成本可忽略。漂移由 `--check` 的摘要比对兜底（`dirDigest` 已有）。备选 symlink 被否：分发语义弱、跨平台差。

### D6. 项目级 MCP 一律直连，不进 gateway/hub

项目层 server 渲染为各 Agent 原生直连条目；OAuth 走 agent-owned 登录（同今天 pi+figma 的 `oauth.clientName` 路径）。每项目一个 gateway 实例（进程生命周期、端口/stdio 复用、workspace 发现时机）复杂度远超收益，v1 不做。hub 同理。全局层的 gateway/hub 条目不受影响。

### D7. 复制与分发：repo 即控制面，渲染产物提交 + `--check` 校验新鲜度

- 渲染产物（`.mcp.json`、`.pi/mcp.json`、`.claude/skills/` 副本等）**提交进 repo**：无 Trellis 的协作者 clone 即用；产物只含 `${VAR}` 引用，无 secret。
- `trellis sync --check`：计算与 sync 相同的 plan，有任何待写入/待修复即非零退出并列出陈旧产物，不落地任何字节——挂 pre-commit 或 CI，像生成代码校验一样防漂移。
- 新机器接管：clone 后 `trellis sync` 自动发现 `.agents/` 并重渲染（幂等）；缺的 `${VAR}` 值由 `doctor` 报缺口、走全局 secrets 流程补齐；各 Agent 的 trust 首次提示按机器/用户重新弹，Trellis 不代答。
- "脱离管控"只有两种，都有明确出口：删掉 `.agents/`（显式脱离，下次 sync 按 managed 标记清理产物）；手改渲染产物（`--check`/sync 报漂移）。
- 备选"产物 gitignore"被否：Trellis 从编译器变成运行时依赖，违背分发设计目标。

### D8. CLI 与维护面

- `trellis init --workspace`：脚手架 `.agents/`（`config.json` 骨架 `{ "version": 1, "mcp": { "servers": {} } }`、空 `skills/`、`AGENTS.md` 模板）；已存在则只补缺，不覆盖（与全局 init 同纪律）。
- `trellis sync`：cwd 向上发现 `.agents/` 则纳入项目层，摘要按层分组打印；`--global-only` 强制旧行为；`--check` 见 D7。
- `trellis mcp add` / `trellis skill add` 加 `--workspace`：写入项目层 canonical（而非全局），随后只渲染项目层目标。不加 flag 维持全局默认——最小惊讶。
- `trellis doctor` / `status`：条目级层归因（global/workspace）、被遮蔽的全局条目、缺失的 `${VAR}`、未托管的项目级配置文件（引导 migrate）。
- 个人私有项目配置（`CLAUDE.local.md` 等 local 变体）永远 agent-owned，Trellis 不读不写。

### D9. 迁移：`trellis migrate --workspace`

流程沿用全局 migrate 纪律（扫描 → dry-run 计划 → 确认 → 备份 → 写入 → 渲染 → 验证）：

1. **扫描**（只读）：D4 表中六家的项目级 MCP/skills/指令路径 + 根 `AGENTS.md`。
2. **secret 拦截**（第一优先级）：复用 `canonical-source-migration` 的既有判定——值匹配 `${NAME}` 视为引用保留；匹配 reject patterns 的明文字面值**不进 canonical**，转为 `${VAR}` 引用、值写入全局 secret store；若该文件已被 git 跟踪且含明文，明确提示建议轮换。
3. **冲突裁决**：同一 server/skill 在多个 Agent 文件里不一致 → 计划里逐条列差异，用户选准，不自动猜。
4. **全局去重**：项目条目与全局 canonical 相同 → 提示二选一：项目层删除（回归全局）或保留为有意覆盖。
5. **个人文件跳过**：`*.local.*` 等列出但不迁。
6. **备份在 repo 外**：`~/.trellis/backups/<timestamp>-workspace-<repo 路径 hash>/`——原文件可能含明文 secret，备份进 repo 等于泄密；回滚 = 备份恢复 + 删 `.agents/` + 重渲染。
7. 迁移是**增量可选**：不迁的既有文件因无 managed 标记永不被覆盖，doctor 提示可迁。

### D10. 规格修订：`canonical-source-loading` 解禁项目层

"Global-only canonical source loading" 的 SHALL NOT（不读项目目录、不接受 root 参数）改写为：默认全局唯一；**仅当**调用方显式传入已发现的 workspaceDir 时加载 `.agents/` 项目层并按 D3 合并。homeDir 双职拆分一并写入该 requirement。原 requirement 的全部现有 scenario 保留（语义反转的两条改写为"默认行为不变"形态）。

## Risks / Trade-offs

- [zcode MCP 同名冲突是用户级优先（唯一反向）] → 项目层与全局同 ID 时 zcode 实际生效的是全局条目，与"workspace 赢"矛盾；sync 检测到此情形对 zcode 打 warning 并在 doctor 层归因里显式标注，不静默。
- [渲染产物入库后，`.agents/` 改了但忘 sync，产物过期] → `--check` 挂 CI/pre-commit；sync 摘要提示。
- [协作者直接手改渲染产物并提交，Trellis 下次 sync 覆盖] → 产物头部 managed 标记写明 "generated from .agents/, do not edit"（JSON 无注释的用约定 key 或伴随 manifest）；覆盖前 drift 报告。
- [`.agents/` 向上发现穿透到家目录误拾取（如 `~/.agents/` 被当成 workspace）] → 发现算法在 home 目录处止步，`~/` 本身永不视为 workspace root；`~/.agents/` 未来若做全局层是独立决策。
- [信任门控差异：Codex/pi 对未信任项目可能整目录拒读] → Trellis 只写文件；用户首次在 Agent 内批准，文档写明这是预期行为而非故障。
- [约 40 个 `loadCanonicalSource` 调用点的签名演进引入回归] → 旧字符串签名由重载保留，默认行为逐字节不变；针对性测试 + 全量 `tsx --test`。
- [项目层 `config.json` 与草案最终版 schema 分叉] → 草案仍是 DRAFT 且无参考实现；`version` 字段预留演进空间，分叉时以 Trellis 语义为准并文档化。

## Migration Plan

本变更自身是增量能力，无数据迁移：默认行为零变化（workspaceDir 为 null 时与今天一致）；已有 repo 通过 `trellis migrate --workspace`（D9）按需纳入。回滚：删除 `.agents/` + `trellis sync` 清理产物，或从 `~/.trellis/backups/` 恢复迁移前文件。

## Open Questions

- `.agents/skills/` 对 Kimi Code 项目级的直读在官方文档中已确认，但本机 kimi-code 版本的项目 skills 实际加载行为需在实施期用真实 fixture 验证一次（影响 D4 表中 Kimi 是否需要补充复制投递）。
- zcode 的非官方 CLI（kingsword09/zcode-cli）项目级配置文件的真实读取优先级未文档化，实施期以 probe 实测为准；若实测与调研相反，D4 中 zcode 的 warning 条件随之反转。
