# canonical-source-loading Specification

## Purpose
TBD - created by archiving change trellis-sync-p1. Update Purpose after archive.

## Requirements

### Requirement: Global-only canonical source loading
The system SHALL load a `CanonicalSource` by reading `~/.trellis/skills/*/SKILL.md`,
`~/.trellis/agents/*.md`, `~/.trellis/agents.md`, `~/.trellis/scope.yaml`,
`~/.trellis/mcp/servers.yaml`, and `~/.trellis/secrets.policy.yaml`. By
default the system SHALL NOT read or merge any project-local directory, and
the default invocation SHALL NOT consult the current working directory. Only
when the caller explicitly supplies a workspace root discovered per
`workspace-scope` SHALL the system additionally load that workspace's
`.agents/` layer and merge it per that capability's semantics. The home
directory parameter anchors both the global canonical root and user-home
semantics (such as `~` expansion in `secrets.policy.yaml`'s `env_file`) at
all times; a workspace root SHALL NOT relocate either.

#### Scenario: Global canonical source loads successfully
- **WHEN** `~/.trellis/` exists with at least one skill under
  `~/.trellis/skills/`
- **THEN** `loadCanonicalSource()` returns a `CanonicalSource` whose
  `skills` array includes that skill, with no dependency on the current
  working directory

#### Scenario: No project-local override is ever consulted
- **WHEN** `loadCanonicalSource()` is called without an explicit workspace
  root, from within a project directory that itself contains a `.agents/`
  folder
- **THEN** that project-local folder is never read; only `~/.trellis/` is
  consulted (the default invocation remains global-only; only a caller
  supplying a discovered workspace root opts into the project layer)

#### Scenario: An explicit workspace root is loaded and merged
- **WHEN** `loadCanonicalSource()` is called with a workspace root whose
  `.agents/config.json` declares an MCP server absent from the global layer
- **THEN** the returned `CanonicalSource` includes that server, attributed
  to the workspace layer

#### Scenario: Workspace root never relocates secrets home semantics
- **WHEN** `loadCanonicalSource()` is called with both a home directory and
  a workspace root, and `secrets.policy.yaml` sets `env_file: ~/.secrets.env`
- **THEN** the env file path still expands against the home directory, not
  the workspace root

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

### Requirement: Missing global source is an error, missing individual entries are not
The system SHALL raise an error if `~/.trellis/` does not exist at all when
`loadCanonicalSource()` is called. The system SHALL NOT error if
`~/.trellis/` exists but contains zero skills, zero agent profiles, or no
`scope.yaml` — each of these is valid and yields an empty list or default
scope, not a failure.

#### Scenario: No canonical source at all is an error
- **WHEN** `~/.trellis/` does not exist
- **THEN** `loadCanonicalSource()` throws, rather than returning an empty
  `CanonicalSource` that would look identical to "verified clean"

#### Scenario: An empty but present canonical source is valid
- **WHEN** `~/.trellis/` exists but `~/.trellis/skills/` contains no
  subdirectories
- **THEN** `loadCanonicalSource()` returns a `CanonicalSource` with an
  empty `skills` array, not an error

### Requirement: A scope.yaml reference to a nonexistent item is a diagnostic, not a hard failure
The system SHALL record a diagnostic when `scope.yaml` names a skill,
agent profile, or memory entry that does not exist in canonical, and SHALL
continue loading every other, valid entry rather than aborting the whole
load.

#### Scenario: One bad scope.yaml entry doesn't block everything else
- **WHEN** `scope.yaml` restricts a skill name that doesn't exist under
  `~/.trellis/skills/` (e.g. a stale entry after a rename), alongside a
  valid scope restriction on a skill that does exist
- **THEN** `loadCanonicalSource()` returns successfully, the valid skill's
  scope is applied normally, and a diagnostic names the stale entry
