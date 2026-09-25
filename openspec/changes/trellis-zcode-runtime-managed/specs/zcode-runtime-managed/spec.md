# Spec Delta

## Purpose

Provide ZCode with a safe, profile-aware Trellis-managed Runtime delivery that
keeps scoped capabilities and user-owned ZCode state intact across supported
CLI and desktop configuration layouts.

## ADDED Requirements

### Requirement: ZCode profile selection is explicit and read-only

The system SHALL identify a ZCode installation as either a compatible public
CLI profile, a desktop/configuration-only profile, or absent. A compatible
`zcode-app-cli` profile SHALL use `~/.zcode/cli/setting.json`; an official
profile SHALL use `~/.zcode/cli/config.json`. The probe SHALL report the
selected path and version without reading credentials, session databases, or
private desktop application bundles.

#### Scenario: Local community CLI selects its native settings file
- **WHEN** `zcode version` identifies `zcode-app-cli` on a machine
- **THEN** the ZCode snapshot is present and identifies
  `~/.zcode/cli/setting.json` as its managed configuration path

#### Scenario: No public CLI remains configuration-only
- **WHEN** ZCode configuration exists but no compatible public `zcode`
  executable is available
- **THEN** the snapshot remains available for configuration management and
  reports that CLI execution is unavailable without invoking an application
  bundle path

### Requirement: Runtime-only ZCode receives one scoped capability edge

When ZCode's runtime delivery is `mcp`, the system SHALL project one owned
stdio MCP entry named `trellis` that invokes `trellis mcp-runtime --agent
zcode`. It SHALL deliver canonical Skills, shared Memory, and eligible
upstream MCP servers through that edge, applying the same scope, secrets, and
route rules as other Runtime agents.

#### Scenario: Runtime delivery produces one native entry
- **WHEN** ZCode is managed with Runtime delivery and canonical has several
  eligible Skills and MCP servers
- **THEN** its native configuration contains the single owned `trellis` MCP
  entry and does not contain one native entry per canonical upstream server

### Requirement: Runtime-only delivery prevents ambient native Skill leakage

When ZCode's runtime delivery is `mcp`, the system SHALL manage its native
Skill enablement switches so that automatic discovery of `~/.agents/skills`
does not expose Skills outside canonical scope. The prior values SHALL be
restored only when the current values still match Trellis's recorded managed
values.

#### Scenario: A Codex-only Skill is not visible to Runtime-only ZCode
- **WHEN** `~/.agents/skills` contains a Skill scoped only to Codex and
  ZCode uses Runtime delivery
- **THEN** ZCode cannot load that Skill natively and receives only Skills in
  ZCode's canonical scope through Trellis Runtime

### Requirement: Shared instructions are projected safely

The system SHALL project canonical shared instructions to
`~/.zcode/AGENTS.md` using the existing create, repair, removal, conflict,
and backup semantics for Trellis-managed symlinks.

#### Scenario: Existing user-authored ZCode instructions are preserved
- **WHEN** `~/.zcode/AGENTS.md` exists as a regular user-authored file
- **THEN** sync reports a conflict and does not modify that file

### Requirement: ZCode configuration ownership preserves unrelated state

The system SHALL update only Trellis-owned entries in the selected nested
`mcp.servers` map and its recorded Runtime-only Skill controls. It SHALL
preserve unrelated MCP servers and all unrelated configuration keys, and it
SHALL use Trellis backup and ownership records for every modification.

#### Scenario: Unrelated ZCode configuration survives Runtime sync
- **WHEN** the selected ZCode config contains user provider, UI, plugin, and
  unrelated MCP settings
- **THEN** syncing the Trellis Runtime entry leaves each unrelated setting
  semantically unchanged
