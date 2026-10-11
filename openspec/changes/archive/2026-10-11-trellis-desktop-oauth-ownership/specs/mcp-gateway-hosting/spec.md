# Spec Delta

## MODIFIED Requirements

### Requirement: Gateway mode collapses every server to one native stdio entry per agent
When gateway mode is enabled for an Agent, the system SHALL write one native
stdio entry pointing to the Trellis gateway/runtime with that Agent id. Ordinary
and explicitly Trellis-owned upstreams SHALL use that entry without duplicate
per-server native entries. Agent-owned OAuth connections SHALL remain separate
native entries so each Agent retains its own authorization.

#### Scenario: Gateway mode produces one entry regardless of server count
- **WHEN** gateway mode is enabled and five ordinary servers include three in scope
- **THEN** one gateway entry is written instead of three native server entries

#### Scenario: Gateway mode is independent per agent
- **WHEN** gateway mode applies to Claude Code only and other Agents remain direct
- **THEN** Claude Code receives its gateway and native OAuth entries while other
  Agents retain their eligible native entries

#### Scenario: Native OAuth remains separate from the gateway
- **WHEN** an Agent-owned OAuth server is in scope for a gateway Agent
- **THEN** its native entry is retained beside the gateway and its credentials
  remain owned by that Agent

### Requirement: The gateway subcommand aggregates in-scope upstream servers behind a standard MCP Server
The system SHALL resolve the in-scope server set, excluding Agent-owned OAuth
servers and including explicitly Trellis-owned OAuth servers. It SHALL connect
each eligible upstream and preserve disabled-server, scope and failure isolation
behavior. It SHALL NOT use or import Agent-owned OAuth credentials.

#### Scenario: The gateway only aggregates servers in scope for the requesting agent
- **WHEN** an ordinary server is scoped to codex only
- **THEN** the Claude Code gateway does not connect to that server

#### Scenario: A disabled server is never connected to by the gateway
- **WHEN** a canonical server has enabled false
- **THEN** no gateway connects to it regardless of ownership

#### Scenario: An OAuth server is excluded from gateway upstreams
- **WHEN** Figma is OAuth-classified without explicit Trellis ownership
- **THEN** the gateway excludes it and the Agent handles its native connection

#### Scenario: An explicitly hosted OAuth server uses its own credential
- **WHEN** a server has Trellis ownership and a valid Trellis token
- **THEN** the gateway attaches that token without reading Agent credentials

### Requirement: First-time OAuth authorization is a manual, user-invoked command; the gateway never opens a browser
Interactive authorization SHALL start only through the human-invoked CLI or an
explicit desktop action. It SHALL perform discovery, applicable registration,
PKCE, browser launch, loopback callback and token exchange. The gateway SHALL
never start interactive authorization, open a browser or wait for user input.

#### Scenario: Running the auth command performs the full interactive flow
- **WHEN** a human invokes the auth command for a remote server
- **THEN** the existing OAuth flow runs and successful credentials are saved

#### Scenario: The gateway subcommand never initiates authorization on its own
- **WHEN** the gateway lacks a required hosted credential
- **THEN** it reports the authorization requirement without opening a browser

#### Scenario: The desktop invokes authorization explicitly
- **WHEN** the user clicks authorize on a Trellis-owned server
- **THEN** the desktop task runs the same structured OAuth flow as the CLI
