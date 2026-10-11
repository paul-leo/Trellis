# Spec Delta

## Purpose

让 Trellis 在保持全局层（`~/.trellis/`）默认行为不变的前提下，发现、加载并合并仓库内 `.agents/` 项目层 canonical source，使项目级 MCP/skills/指令可以随 repo 分发，且合并方向与行业惯例（workspace 覆盖全局）一致。

## ADDED Requirements

### Requirement: Workspace root discovery
The system SHALL provide a discovery function that, given a starting directory, walks ancestor directories upward and returns the first directory containing a `.agents/` subdirectory as the workspace root, or `null` when none exists. Discovery SHALL stop before treating the user's home directory itself as a workspace root, and SHALL NOT require the workspace to be a git repository.

#### Scenario: Nearest ancestor with .agents wins
- **WHEN** the current directory is `<repo>/src/deep` and both `<repo>/.agents/` and `<repo>/src/.agents/` exist
- **THEN** discovery returns `<repo>/src` (the nearest ancestor containing `.agents/`)

#### Scenario: No .agents anywhere yields global-only behavior
- **WHEN** no ancestor of the current directory contains a `.agents/` directory
- **THEN** discovery returns `null` and every command behaves exactly as global-only

#### Scenario: Home directory is never a workspace root
- **WHEN** `~/.agents/` exists and the current directory is somewhere under `~/some-project/` that has no `.agents/` of its own
- **THEN** discovery returns `null`, not `~`

### Requirement: Project layer loading with schema versioning
The system SHALL load the project layer from `<workspace>/.agents/`: `config.json` (MCP declarations), `AGENTS.md` (instructions), and `skills/<name>/SKILL.md` (skills), each optional. `config.json` SHALL carry a `version` field (absent means `1`); a version newer than the implementation understands SHALL produce a clear "upgrade Trellis" error rather than a silent misread, and unknown top-level keys SHALL produce a warning, not an error. Server declarations in `config.json` SHALL be validated by the same validator as canonical `servers.yaml` entries.

#### Scenario: Minimal valid project layer
- **WHEN** `<workspace>/.agents/config.json` contains `{ "version": 1, "mcp": { "servers": {} } }` and no other files exist
- **THEN** the project layer loads as valid and empty

#### Scenario: Newer schema version refuses cleanly
- **WHEN** `config.json` declares `"version": 99`
- **THEN** loading fails with an error naming the unsupported version and instructing the user to upgrade Trellis

#### Scenario: Invalid server entry is rejected by the shared validator
- **WHEN** `config.json` declares an MCP server with a `transport` value the canonical schema does not support
- **THEN** loading fails with the same diagnostic the equivalent `servers.yaml` entry would produce

### Requirement: Layer merge semantics with provenance
When a workspace layer is present, the system SHALL merge it over the global layer: an MCP server or skill whose ID appears in both layers resolves to the workspace entry; a workspace entry with `enabled: false` SHALL act as a tombstone that disables the same-ID global entry without rendering anything; instructions SHALL NOT be content-merged (each layer is delivered to its own level's paths, per workspace-delivery). The merged result SHALL carry per-entry provenance (`global` or `workspace`) and a list of shadowed or tombstoned global entries.

#### Scenario: Same-ID server resolves to workspace
- **WHEN** global `servers.yaml` and workspace `config.json` both declare a server named `figma` with different URLs
- **THEN** the merged view's `figma` is the workspace entry, with provenance `workspace`, and the global entry appears in the shadowed list

#### Scenario: Tombstone disables a global server
- **WHEN** workspace `config.json` declares `{ "figma": { "enabled": false } }` and global `servers.yaml` has `figma`
- **THEN** the merged view contains no active `figma`, and the tombstone is reported in the shadowed list

#### Scenario: Provenance survives a full load
- **WHEN** a canonical source is loaded with both layers present
- **THEN** every MCP server and skill in the result can be attributed to exactly one layer

### Requirement: Secrets stay global-only
The secrets policy (`secrets.policy.yaml`) and all secret values SHALL remain exclusively in the global layer. The project layer SHALL carry only `${VAR}` references; the system SHALL refuse to load a project-layer `config.json` whose `env`, `staticEnv`, `headers`, or `auth` fields contain a literal value matching the policy's reject patterns, and SHALL name the offending entry.

#### Scenario: Project layer with env reference loads
- **WHEN** workspace `config.json` declares a server with `env: ["GITHUB_TOKEN"]`
- **THEN** it loads normally; resolution of the value happens from the global secret store at delivery time

#### Scenario: Project layer with a plaintext credential is refused
- **WHEN** workspace `config.json` contains a header value matching a known-dangerous credential pattern (e.g. `ghp_...`)
- **THEN** loading fails with an error naming the server and field, and nothing is written anywhere

### Requirement: Trellis never answers agent trust prompts
The system SHALL only write workspace files; it SHALL NOT mark a project as trusted, accept a trust prompt, or otherwise alter any agent's trust state for project-level configuration.

#### Scenario: Fresh clone with delivered config
- **WHEN** a workspace sync writes `.mcp.json` into a freshly cloned repo
- **THEN** no trust store of any agent is modified; the agent's own first-use prompt is the only approval path
