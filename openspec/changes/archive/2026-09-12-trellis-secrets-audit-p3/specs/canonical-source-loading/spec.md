## MODIFIED Requirements

### Requirement: Global-only canonical source loading
The system SHALL load a `CanonicalSource` by reading `~/.trellis/skills/*/SKILL.md`,
`~/.trellis/agents/*.md`, `~/.trellis/agents.md`, `~/.trellis/scope.yaml`,
`~/.trellis/mcp/servers.yaml`, and `~/.trellis/secrets.policy.yaml`. The
system SHALL NOT read or merge any project-local `.trellis/` directory, and
SHALL NOT accept a root/workspace parameter that would enable one.

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

#### Scenario: secrets.policy.yaml populates canonical.secretsPolicy
- **WHEN** `~/.trellis/secrets.policy.yaml` exists with `allowed_vars` and
  `reject_patterns`
- **THEN** `loadCanonicalSource()` returns a `CanonicalSource` whose
  `secretsPolicy.allowedVars` matches that file's `allowed_vars`, and
  whose `secretsPolicy.rejectPatterns` is a `RegExp` compiled from each
  string in `reject_patterns`

#### Scenario: A missing secrets.policy.yaml yields an empty, valid policy
- **WHEN** `~/.trellis/secrets.policy.yaml` does not exist
- **THEN** `loadCanonicalSource()` returns `secretsPolicy: { allowedVars: [], rejectPatterns: [] }`,
  not an error — this file is optional, same as `mcp/servers.yaml`
