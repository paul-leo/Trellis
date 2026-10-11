# mcp-auth-guidance Specification

## Purpose
Provide safe, actionable MCP authorization and availability information to
the user or Agent when the Gateway isolates an unavailable upstream server,
and ownership-aware OAuth credential health for the servers whose
authorization Trellis is responsible for.

## Requirements

### Requirement: Upstream status carries a structured tool count

Each `ready` upstream status SHALL include a numeric `toolCount` field
equal to the number of tools that upstream contributed at connect time.
The human-readable `detail` string SHALL be retained unchanged for
existing consumers.

#### Scenario: Agent inspects a healthy upstream

- **WHEN** an upstream connected successfully and contributed N tools
- **THEN** its status entry contains `toolCount: N` alongside the
  existing `detail` text

#### Scenario: Degraded router upstream

- **WHEN** the mcp-router upstream connects but exposes no downstream
  tools
- **THEN** its status entry reports `toolCount: 0` with the existing
  `degraded` status and router remediation

### Requirement: Status reports OAuth-classified server credential health

`trellis.mcp.status` SHALL include an `oauth` array with one entry per
OAuth-classified canonical server in scope for the calling agent, each
carrying an `owner` field (`trellis` or `agent`,
trellis-desktop-oauth-ownership). Trellis-owned entries report the stored
credential's health as a `credential` field with the shared classifier's
status vocabulary, plus `expiresAt` (ISO 8601) when known and a
`remediation` naming `trellis mcp renew` or `trellis mcp auth <name>` when
action is needed. Agent-owned entries SHALL report
`credential: "agent-managed"` without consulting the token store: their
authorization belongs to the Agent's own client, and inferring it from
Trellis's store would misreport a credential the Agent never uses. The
field SHALL NOT be named `status`: the gateway cannot observe a
direct-routed server's connection state, only its stored credential.

#### Scenario: Agent asks about a never-authorized OAuth server

- **WHEN** a Trellis-owned OAuth-classified server is in scope and no
  token is stored
- **THEN** the `oauth` entry reports `credential: "no-token"` with a
  remediation naming `trellis mcp auth <name>`

#### Scenario: Agent-owned server is reported without inference

- **WHEN** an agent-owned OAuth-classified server is in scope
- **THEN** the `oauth` entry reports `owner: "agent"` and
  `credential: "agent-managed"` regardless of what Trellis's token store
  contains

#### Scenario: Agent asks about a healthy OAuth server

- **WHEN** an OAuth-classified server has a stored, unexpired token
- **THEN** the entry reports `credential: "valid"` with `expiresAt` and
  no remediation

#### Scenario: Expired but renewable credential

- **WHEN** the stored token is expired and carries a refresh token
- **THEN** the entry reports `credential: "expired-renewable"` with a
  remediation naming `trellis mcp renew`

### Requirement: Credential reporting is read-only and secret-free

The `oauth` section SHALL be computed from the token store alone: no
token-endpoint contact, no refresh attempt, no writes. No token value,
refresh token, or other secret material SHALL appear in any field.

#### Scenario: Output audit

- **WHEN** `trellis.mcp.status` is called with OAuth-classified servers
  in scope
- **THEN** the output contains no access-token or refresh-token values,
  and the token files on disk are unmodified

### Requirement: MCP status is available through Runtime

The Runtime SHALL expose a read-only `trellis.mcp.status` tool that reports
the status of configured upstream MCP servers without exposing credentials.

#### Scenario: Unauthorized remote server

- **WHEN** a remote MCP server rejects the Gateway connection with an
  authentication response
- **THEN** status reports `auth-required` and recommends
  `trellis mcp auth <server>`

#### Scenario: Missing stdio executable

- **WHEN** a stdio MCP command cannot be started
- **THEN** status reports `unavailable` with the command/install remediation
  and no secret values

### Requirement: Authorization remains user-driven

The status tool and Gateway SHALL NOT open a browser or perform an initial
OAuth grant. They SHALL direct the user to the explicit authorization command.

#### Scenario: Agent asks how to fix authorization

- **WHEN** an Agent calls `trellis.mcp.status` after an upstream auth failure
- **THEN** the result contains a human-readable next action and does not alter
  credentials or configuration

### Requirement: Built-in capabilities survive upstream failures

An unavailable upstream SHALL NOT prevent Runtime Skill and Memory tools from
being listed or called.

#### Scenario: Partial Gateway startup

- **WHEN** one or more upstream servers time out or reject authentication
- **THEN** `trellis.skills.search`, `trellis.skills.read`,
  `trellis.memory.search`, and `trellis.mcp.status` remain available
