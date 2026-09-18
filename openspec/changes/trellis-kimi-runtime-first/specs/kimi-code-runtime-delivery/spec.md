# kimi-code-runtime-delivery Specification

## Purpose

Provide Kimi Code with one Trellis-owned MCP Runtime edge so canonical Skills,
Memory, and selected upstream MCP servers are consumed consistently without
duplicating native Skill discovery or spreading server definitions.

## ADDED Requirements

### Requirement: Kimi Code is a supported managed Agent

The system SHALL identify Kimi Code as the Agent id `kimi-code`, probe its
installed binary and user data root, and include it in managed-agent scope,
onboarding selection, doctor output, and capability selection validation.

#### Scenario: Installed Kimi is discovered

- **WHEN** `kimi --version` succeeds and `~/.kimi-code` exists
- **THEN** the Kimi probe reports `present: true`, its version, and its
  Kimi-specific MCP configuration path without reading credential values

#### Scenario: Missing Kimi does not fail other probes

- **WHEN** Kimi Code is not installed
- **THEN** its snapshot reports `present: false` and Claude Code, Codex, Kiro,
  and pi probing continues normally

### Requirement: Runtime delivery gives Kimi one owned MCP entry

The system SHALL write at most one Trellis-owned `trellis-runtime` entry to
Kimi's user-level `~/.kimi-code/mcp.json` when Kimi Runtime delivery is
enabled. The entry SHALL start `trellis mcp-runtime --agent kimi-code` and
SHALL expose Trellis Skill, Memory, and selected upstream providers through
the existing Runtime registry.

#### Scenario: Kimi receives one Runtime entry

- **WHEN** Kimi is managed with Runtime delivery and canonical has multiple
  Skills, memories, and MCP servers
- **THEN** Kimi's managed MCP projection contains one `trellis-runtime` entry,
  not one native entry per upstream server

#### Scenario: Existing Kimi MCP entries survive

- **WHEN** `~/.kimi-code/mcp.json` contains a user-owned server unrelated to
  Trellis
- **THEN** sync preserves that entry byte-for-byte except for the owned
  `trellis-runtime` map entry

### Requirement: Kimi Runtime delivery does not duplicate native Skills

The system SHALL provide a Trellis-managed Kimi launcher mode that starts
Kimi with an empty `--skills-dir` root when Runtime-only Skill delivery is
selected. The launcher SHALL preserve all user arguments and SHALL NOT modify
Kimi's login, provider, session, or project files.

#### Scenario: Runtime-only Kimi does not scan shared native Skills

- **WHEN** Kimi is started through the Trellis Runtime-first launcher
- **THEN** Kimi receives no native user/project Skill roots and discovers
  Trellis Skills only through Runtime's `trellis.skills.*` tools/resources

#### Scenario: Native mode remains available

- **WHEN** Kimi is configured with native or both delivery
- **THEN** Trellis preserves the documented native Kimi Skill behavior and
  does not force the launcher-only isolation mode

### Requirement: Kimi consumes Runtime progressive disclosure

The system SHALL expose Kimi's Runtime Skill and Memory tools/resources using
the same names and scope rules as every other Runtime Agent.

#### Scenario: Kimi searches and reads a canonical Skill

- **WHEN** a Kimi Runtime session calls `trellis.skills.search` and then
  `trellis.skills.read` for an in-scope Skill
- **THEN** it receives metadata first and bounded canonical `SKILL.md` content
  only after selecting that Skill

#### Scenario: Kimi sees only in-scope Memory

- **WHEN** Kimi calls `trellis.memory.search` or reads a memory resource
- **THEN** the response is filtered by the canonical managed-agent and memory
  scope boundary and never exposes an out-of-scope memory

### Requirement: Kimi Runtime upstream routing is isolated and auditable

The system SHALL apply the same route, secret, collision, timeout, and
provider-failure isolation rules to Kimi Runtime as to the existing Runtime
Agents. Kimi adapter sync SHALL NOT resolve or print secret values.

#### Scenario: One failing upstream does not remove Kimi built-ins

- **WHEN** one selected upstream MCP server fails to start for Kimi
- **THEN** Kimi still discovers SkillProvider, MemoryProvider, and healthy
  upstream tools, while the failure is reported on stderr

#### Scenario: Kimi Runtime configuration is idempotent

- **WHEN** `trellis mcp sync` runs twice for Kimi without canonical changes
- **THEN** the second run produces no write and no duplicate Runtime entry
