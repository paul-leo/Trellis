# Spec Delta

## Purpose

Provide safe, actionable MCP authorization and availability information to the
user or Agent when Gateway isolates an unavailable upstream server.

## ADDED Requirements

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
