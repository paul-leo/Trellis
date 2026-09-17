# skill-provider-mcp Specification

## ADDED Requirements

### Requirement: One Trellis MCP Runtime hosts multiple capability providers

The system SHALL expose one MCP runtime edge that can register built-in
providers and selected managed upstream providers under the same agent-scoped
runtime context.

#### Scenario: Skill and upstream MCP are visible through one connection

- **WHEN** an agent uses runtime delivery and canonical enables a skill provider
  plus two selected MCP servers
- **THEN** the agent connects to one Trellis MCP entry and can discover the
  built-in skill capabilities and the selected upstream capabilities

#### Scenario: A provider failure does not corrupt unrelated providers

- **WHEN** one upstream provider fails during startup
- **THEN** built-in providers and healthy upstream providers remain available
  and the failure is reported without writing secrets to stdout

### Requirement: Runtime supports tools, resources, and prompts independently

The system SHALL register only the MCP primitives each provider implements and
SHALL route built-in and upstream names without collisions.

#### Scenario: Skill content is available as both tool output and resource

- **WHEN** the client supports resources and calls `trellis.skills.read`
- **THEN** the provider returns the skill content with provenance and also
  exposes the canonical `trellis://skills/<name>/SKILL.md` resource

### Requirement: Skill provider exposes canonical skills on demand

The runtime SHALL provide read-only skill search, `SKILL.md` read, and bounded
supporting-file read operations.

#### Scenario: Search returns metadata without full skill bodies

- **WHEN** an agent calls `trellis.skills.search`
- **THEN** the response contains matching names, descriptions, scope status,
  and fingerprints without loading every full skill body

#### Scenario: Read returns one selected skill

- **WHEN** an agent calls `trellis.skills.read` for an in-scope skill
- **THEN** the runtime returns that skill's `SKILL.md` and provenance metadata

### Requirement: Runtime access is scope-filtered by agent identity

The system SHALL require a supported agent id and SHALL apply canonical scope
to every provider request, including upstream resource and prompt access.

#### Scenario: An out-of-scope skill is invisible

- **WHEN** a skill is scoped to `claude-code` and Codex calls runtime search or
  read
- **THEN** the skill is not returned and its body is not revealed

### Requirement: Supporting-file reads are confined to the skill root

The system SHALL reject absolute paths, traversal, symlink escapes, secret
files, and files over the configured size limit.

#### Scenario: Path traversal is rejected

- **WHEN** an agent requests `../../secrets.env`
- **THEN** the runtime returns an error and reads no file outside the skill root

### Requirement: Runtime exposes canonical memory through a replaceable provider

The system SHALL expose in-scope canonical Markdown memories through a
storage-independent, read-only `MemoryProvider` mounted in the same Runtime
entry as skills and upstream MCP tools.

#### Scenario: Search returns memory metadata before content

- **WHEN** an agent calls `trellis.memory.search` with a matching query
- **THEN** the runtime returns matching names, fingerprints, provenance, and
  resource URIs without returning full memory bodies

#### Scenario: Read returns one canonical memory

- **WHEN** an agent calls `trellis.memory.read` for an in-scope memory
- **THEN** the runtime returns its Markdown content, fingerprint, provenance,
  and `trellis://memories/<name>.md` URI

#### Scenario: Memory scope is enforced on every request

- **WHEN** a memory is scoped to Claude Code and Codex searches, reads, or
  requests its resource
- **THEN** that memory is invisible to Codex

#### Scenario: A different backend preserves the agent-facing contract

- **WHEN** a read-only local-graph or OpenViking provider implements the
  `MemoryProvider` contract
- **THEN** Runtime can expose it through the same search/read/resource names
  without changing the MCP transport edge

### Requirement: Runtime memory access is read-only

The Runtime MemoryProvider SHALL NOT expose remember, delete, graph mutation,
canonical mutation, or configuration mutation tools in this change.

#### Scenario: A model attempts to write memory

- **WHEN** an agent calls an unregistered memory mutation tool such as
  `trellis.memory.remember`
- **THEN** Runtime rejects it as unknown and no canonical or graph file changes

### Requirement: Runtime delivery is additive and backwards compatible

The system SHALL preserve native delivery by default and SHALL support native,
runtime MCP, and both delivery per managed agent. Enabling runtime delivery
SHALL NOT delete canonical skill files or break existing direct/gateway routes.

#### Scenario: Both delivery modes coexist

- **WHEN** Codex is configured for `both`
- **THEN** native skill projection remains present and one owned runtime MCP
  entry is also available

### Requirement: Built-in providers never execute skill code or mutate canonical

The system SHALL never execute scripts, install dependencies, fetch arbitrary
network content, migrate agents, change MCP routes, or delete canonical data as
a consequence of a model-visible provider request.

#### Scenario: Script content is readable but not executed

- **WHEN** a skill contains `scripts/setup.sh` and an agent reads it
- **THEN** the runtime returns bounded content only and starts no child process
