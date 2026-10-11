# workspace-migration Specification

## Purpose
让已有项目级配置的仓库可以增量、安全地迁入 `.agents/` 项目层托管：先扫描出计划，拦截明文 secret，冲突交给用户裁决，备份放 repo 外，迁移后渲染结果与迁移前功能等价。

## Requirements

### Requirement: Workspace migration scan and plan
`trellis migrate --workspace` SHALL scan the current workspace's existing project-level configuration across all six agents' known paths (`.mcp.json`, `.codex/config.toml`, `.kiro/settings/mcp.json`, `.kiro/skills/`, `.kiro/steering/`, `.pi/mcp.json`, `.pi/skills/`, `.kimi-code/mcp.json`, `.kimi-code/skills/`, zcode's project config, root `AGENTS.md`, `.claude/skills/`, `.agents/skills/`) and produce a migration plan classifying each found item by dimension (MCP / skill / instructions). The system SHALL support `--dry-run`, printing the identical plan the real run would execute while writing nothing.

#### Scenario: Plan lists every discovered item
- **WHEN** a repo contains `.mcp.json` with two servers, `.claude/skills/review/`, and a root `AGENTS.md`
- **THEN** the migration plan lists both servers, the skill, and the instructions file, each with its proposed destination under `.agents/`

#### Scenario: Dry run writes nothing
- **WHEN** `trellis migrate --workspace --dry-run` runs in that repo
- **THEN** the plan is printed and no file anywhere is created, modified, or deleted

### Requirement: Plaintext secrets are intercepted, never imported
Migration SHALL classify every candidate env/header/auth value: an exact `${NAME}` match is preserved as a reference; a value matching the policy's reject patterns SHALL NOT be copied into `.agents/` — the migration SHALL instead write the value into the global secret store, write a `${VAR}` reference in its place, and report the conversion. When the source file is git-tracked and contained such a literal, the migration report SHALL advise rotating that credential.

#### Scenario: Real API key is extracted to the global store
- **WHEN** the repo's `.mcp.json` contains a server whose `env` maps `GITHUB_TOKEN` to a literal `ghp_...` value
- **THEN** `.agents/config.json` receives only the `${GITHUB_TOKEN}` reference, the value lands in the global secret store, and the report names the conversion plus a rotation advisory if the file is git-tracked

#### Scenario: Existing reference passes through untouched
- **WHEN** a source server already uses `${GITHUB_TOKEN}`
- **THEN** the migrated entry keeps the reference and no secret-store write occurs

### Requirement: Conflicts are decided by the user, never guessed
When the same server ID or skill name appears in multiple agents' project files with differing definitions, the migration plan SHALL present each variant side by side and SHALL require an explicit user choice of the authoritative one before writing; non-interactive invocation without a choice SHALL refuse with a clear error.

#### Scenario: Two agents disagree on one server
- **WHEN** `.mcp.json` and `.pi/mcp.json` both define `figma` with different URLs
- **THEN** the plan shows both definitions and migration proceeds only after the user picks one

### Requirement: Duplicates of global entries are a deliberate choice
When a workspace item is identical to a global canonical entry of the same ID, the migration plan SHALL report the duplication and offer both resolutions — drop it from the project layer (fall back to global) or keep it as an intentional workspace override — recording whichever the user chose.

#### Scenario: Project server identical to global
- **WHEN** the repo's `.mcp.json` defines `mailbox` byte-identical to the global canonical entry
- **THEN** the plan flags it as a duplicate and the user's choice is honored: omitted from `.agents/` or kept as an override

### Requirement: Personal local files are never migrated
Files matching agents' personal-local conventions (e.g. `CLAUDE.local.md`, `.kiro/settings/local.*`) SHALL be listed in the plan as skipped and SHALL NOT be read into canonical, moved, or modified.

#### Scenario: Local files listed but untouched
- **WHEN** the repo contains `CLAUDE.local.md`
- **THEN** the plan shows it under "skipped (personal)" and the file is byte-identical after migration

### Requirement: Backup lives outside the repository
Before any write, migration SHALL back up every file it will modify or move into `~/.trellis/backups/<timestamp>-workspace-<repo-path-hash>/`, because source files may contain plaintext secrets and SHALL NOT be copied anywhere inside the repo. Rollback SHALL restore from that backup and remove the generated `.agents/` content.

#### Scenario: Backup contains the pre-migration originals
- **WHEN** migration modifies `.mcp.json` and creates `.agents/`
- **THEN** the original `.mcp.json` bytes exist under the backup directory, and no backup file was written inside the repo

#### Scenario: Rollback restores the pre-migration state
- **WHEN** the user rolls back a workspace migration
- **THEN** the modified source files are restored from backup and the rendered workspace artifacts are removed

### Requirement: Migration is incremental and coexists with unmigrated files
Migration MAY cover any subset of discovered items. Files the user declines to migrate SHALL remain untouched and SHALL NOT be overwritten by later syncs (they carry no managed marker); `trellis doctor` SHALL list them as unmigrated project-level configuration with a hint to run `migrate --workspace`.

#### Scenario: Partial migration leaves the rest alone
- **WHEN** the user migrates only the MCP servers out of a repo that also has hand-written `.claude/skills/`
- **THEN** the skills are unchanged, later syncs still refuse to overwrite them, and doctor lists them as unmigrated

### Requirement: Post-migration render is functionally equivalent
After migration writes `.agents/` and re-renders, each managed agent's effective project-level configuration SHALL be functionally equivalent to the pre-migration state (same servers, skills, and instructions available), and the migration report SHALL summarize before/after per agent.

#### Scenario: Agent configs survive the round trip
- **WHEN** migration completes for a repo whose `.mcp.json` had two servers
- **THEN** the re-rendered `.mcp.json` exposes the same two servers (references instead of literals where secrets were intercepted), and the report shows the equivalence summary
