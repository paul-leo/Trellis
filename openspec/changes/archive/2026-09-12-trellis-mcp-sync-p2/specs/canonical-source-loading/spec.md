## MODIFIED Requirements

### Requirement: Global-only canonical source loading
The system SHALL load a `CanonicalSource` by reading `~/.trellis/skills/*/SKILL.md`,
`~/.trellis/agents/*.md`, `~/.trellis/agents.md`, `~/.trellis/scope.yaml`,
and `~/.trellis/mcp/servers.yaml`. The system SHALL NOT read or merge any
project-local `.trellis/` directory, and SHALL NOT accept a root/workspace
parameter that would enable one.

#### Scenario: Global canonical source loads successfully
- **WHEN** `~/.trellis/` exists with at least one skill under
  `~/.trellis/skills/`
- **THEN** `loadCanonicalSource()` returns a `CanonicalSource` whose
  `skills` array includes that skill, with no dependency on the current
  working directory

#### Scenario: No project-local override is ever consulted
- **WHEN** `loadCanonicalSource()` is called from within a project
  directory that itself contains a `.trellis/` folder
- **THEN** that project-local folder is never read; only `~/.trellis/` is
  consulted

#### Scenario: mcp/servers.yaml populates canonical.mcp
- **WHEN** `~/.trellis/mcp/servers.yaml` exists with at least one server
  definition
- **THEN** `loadCanonicalSource()` returns a `CanonicalSource` whose `mcp.servers`
  includes that definition, and whose `mcp.knownHostInjected` and
  `mcp.hub` reflect that file's `known_host_injected` and `hub` fields
  when present

#### Scenario: A missing mcp/servers.yaml yields an empty, valid mcp config
- **WHEN** `~/.trellis/mcp/servers.yaml` does not exist
- **THEN** `loadCanonicalSource()` returns `mcp: { servers: {}, knownHostInjected: [] }`,
  not an error — this file is optional, same as skills/agents/memories
