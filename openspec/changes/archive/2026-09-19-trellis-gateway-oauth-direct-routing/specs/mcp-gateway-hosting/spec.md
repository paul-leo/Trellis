# Spec Delta

## MODIFIED Requirements

### Requirement: The gateway subcommand aggregates in-scope upstream servers behind a standard MCP Server

The system SHALL, on startup, resolve the same in-scope server set an agent's
ordinary direct-mode plan would have used, excluding every canonical server
marked `auth: oauth`, connect to each remaining one, and expose the aggregate
through a standard MCP Server. An OAuth-classified server SHALL NOT be
connected by the gateway.

#### Scenario: The gateway only aggregates servers in scope for the requesting agent

- **WHEN** `trellis mcp-gateway` is spawned by claude-code, and one
  canonical ordinary server is scoped to `agents: [codex]` only
- **THEN** that codex-only server is not connected to and its tools do
  not appear in the gateway's `tools/list` response to claude-code

#### Scenario: A disabled server is never connected to by the gateway

- **WHEN** a canonical server has `enabled: false`
- **THEN** the gateway subcommand does not attempt to connect to it,
  regardless of agent scope

#### Scenario: An OAuth server is excluded from gateway upstreams

- **WHEN** `figma` is marked `auth: oauth` and Claude Code uses gateway mode
- **THEN** the gateway does not connect to Figma and Figma's tools do not
  appear in the gateway's tools list

## ADDED Requirements

### Requirement: Gateway-mode native plans support direct OAuth entries

When a managed Agent uses gateway mode, its native MCP plan SHALL contain one
gateway/runtime entry for ordinary MCP and one direct MCP entry per eligible
`auth: oauth` server. If the Agent's route contains an explicit server list,
the OAuth entries SHALL be limited to that list. The gateway/runtime entry
SHALL remain available for Trellis-owned Runtime providers even when every
upstream server is OAuth-classified.

#### Scenario: Mixed gateway plan

- **WHEN** `tanka` is ordinary and `figma` is `auth: oauth` under a gateway
  route
- **THEN** native config contains one Trellis gateway/runtime entry plus a
  direct Figma entry, and the gateway's upstream set contains only Tanka

#### Scenario: OAuth-only gateway plan

- **WHEN** every eligible server is `auth: oauth`
- **THEN** native config contains direct OAuth entries and the Trellis
  gateway/runtime entry, while the gateway connects to no OAuth server
