# Spec Delta

## Purpose

把项目层 canonical 内容渲染到各受管 Agent 的项目级原生路径，渲染产物可提交 repo 供无 Trellis 的协作者使用，并通过 `--check` 模式与层归因保持长期不漂移。

## ADDED Requirements

### Requirement: Layer-preserving delivery targets
When a workspace layer is in scope, the system SHALL render workspace-layer content only into each managed agent's project-level native paths — Claude Code: `.mcp.json` and `.claude/skills/`; Codex: `.codex/config.toml`; Kiro: `.kiro/settings/mcp.json`, `.kiro/skills/`, and `.kiro/steering/`; pi: `.pi/mcp.json`; Kimi Code: `.kimi-code/mcp.json`; zcode: the selected `zcode.json`/`.zcode/config.json` — and SHALL NOT re-render global-layer content into project-level files. Final layering across levels is delegated to each agent's native precedence. Skills delivery SHALL be skipped for agents that natively read `.agents/skills/` (Codex, pi, Kimi Code), where the canonical directory is itself the deliverable.

#### Scenario: Workspace MCP server reaches each agent's project config
- **WHEN** a workspace declares server `figma` and all six agents are managed
- **THEN** sync writes `figma` into `.mcp.json`, `.codex/config.toml`, `.kiro/settings/mcp.json`, `.pi/mcp.json`, `.kimi-code/mcp.json`, and zcode's project config, and global config files are untouched by the workspace entries

#### Scenario: Global entries are not copied into project files
- **WHEN** a global-only server `mailbox` exists and a workspace sync runs
- **THEN** no project-level config file gains a `mailbox` entry

#### Scenario: Skills for .agents-native agents need no copy
- **WHEN** the workspace has `.agents/skills/review/SKILL.md` and Codex, pi, and Kimi Code are managed
- **THEN** sync creates no `.codex`/`.pi`/`.kimi-code` skill copies for `review`

### Requirement: Project skills are copied, never symlinked
Workspace skills delivered to agents that need a copy (Claude Code, Kiro) SHALL be written as real file copies, not symlinks, so the rendered artifacts are committable and usable on filesystems and platforms without symlink support. Drift between `.agents/skills/<name>/` and its delivered copy SHALL be detected by content digest comparison.

#### Scenario: Copied skill is a real directory
- **WHEN** sync delivers workspace skill `review` to Claude Code
- **THEN** `.claude/skills/review/` contains real files identical in content to `.agents/skills/review/`, and is not a symlink

#### Scenario: Stale copy is reported as drift
- **WHEN** `.agents/skills/review/SKILL.md` is edited after the last sync
- **THEN** the next sync (or `--check`) reports `.claude/skills/review/` as stale and re-renders it

### Requirement: Rendered artifacts are managed, committable, and never silently overwrite user files
Every workspace-rendered file SHALL carry a managed marker identifying it as generated from `.agents/`. The system SHALL refuse to write a project-level path that exists as user-authored content without a managed marker, reporting it and directing the user to `migrate --workspace` instead. Rendered artifacts contain only `${VAR}` references and SHALL be safe to commit.

#### Scenario: Hand-written .mcp.json is refused, not overwritten
- **WHEN** a repo has a hand-written `.mcp.json` with no managed marker and a workspace sync runs
- **THEN** sync does not modify it, reports the conflict, and suggests `trellis migrate --workspace`

#### Scenario: Rendered artifact carries no secret values
- **WHEN** a workspace server uses `env: ["GITHUB_TOKEN"]`
- **THEN** the rendered `.mcp.json` entry contains only the variable reference form, never a resolved value

### Requirement: Check mode validates freshness without writing
The system SHALL support `trellis sync --check`, which computes the same plan as a real sync, writes nothing, and exits non-zero listing every stale or missing rendered artifact when the workspace (or global) layer is out of date.

#### Scenario: Fresh workspace passes
- **WHEN** all rendered artifacts match the current `.agents/` content
- **THEN** `trellis sync --check` exits zero and the working tree is unchanged

#### Scenario: Stale artifact fails the check
- **WHEN** `.agents/config.json` gained a server after the last sync
- **THEN** `--check` exits non-zero, names the outdated target files, and writes nothing

### Requirement: Workspace participation is automatic but revocable
`trellis sync` run inside a workspace SHALL include the workspace layer by default and SHALL print a per-layer summary; `--global-only` SHALL force the previous global-only behavior. Outside any workspace, sync behavior SHALL be byte-identical to before this change.

#### Scenario: Sync inside a repo picks up the project layer
- **WHEN** `trellis sync` runs in a directory whose ancestor contains `.agents/`
- **THEN** the workspace layer is rendered and the summary groups results by layer

#### Scenario: Sync outside any repo is unchanged
- **WHEN** `trellis sync` runs in a directory with no `.agents/` ancestor
- **THEN** only global delivery happens, with the same plan and output shape as before

### Requirement: Workspace servers never route through gateway or hub
Workspace-layer MCP servers SHALL be rendered as direct agent-native entries only. The system SHALL NOT start per-workspace gateway instances, SHALL NOT add workspace servers to the global gateway or hub configuration, and SHALL render OAuth-capable workspace servers in the agent-owned bare form (e.g. pi's `oauth.clientName`) so each agent performs its own login.

#### Scenario: OAuth workspace server is agent-owned
- **WHEN** a workspace server declares `auth: { kind: oauth, client_name: "Claude Code" }`
- **THEN** pi's `.pi/mcp.json` entry renders as a bare URL with `oauth.clientName`, and `trellis mcp auth` is not involved

### Requirement: ZCode reverse precedence is surfaced
Because zcode's user-level MCP configuration wins over project-level on same-name conflicts, the system SHALL emit a warning during sync and record the deviation in doctor's layer attribution whenever a workspace MCP server shadows a global entry for zcode, rather than silently implying workspace-wins.

#### Scenario: Shadowed zcode server warns
- **WHEN** workspace `config.json` redefines a server that also exists globally and zcode is managed
- **THEN** sync prints a warning that zcode will actually use the user-level entry, and doctor marks the entry accordingly

### Requirement: Status and doctor attribute every entry to its layer
`trellis doctor` and status output SHALL show, for each effective MCP server and skill, which layer it came from, SHALL list shadowed or tombstoned global entries, and SHALL list unresolved `${VAR}` references in the workspace layer as missing-secret diagnostics.

#### Scenario: Doctor shows a shadowed global server
- **WHEN** the workspace redefines global server `figma`
- **THEN** doctor output shows `figma` as workspace-sourced and notes the global entry is shadowed

#### Scenario: Missing secret on a fresh machine is a diagnostic
- **WHEN** a freshly cloned workspace references `${FIGMA_TOKEN}` and the global secret store has no value for it
- **THEN** doctor reports the missing variable and the sync completes with the reference intact
