# Spec Delta

## Purpose

修订 canonical source 加载的边界：默认仍是全局唯一（`~/.trellis/`），但允许调用方显式传入已发现的 workspace root 以加载 `.agents/` 项目层；同时拆分 homeDir 的"canonical 定位"与"用户主目录"双职语义。

## MODIFIED Requirements

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
