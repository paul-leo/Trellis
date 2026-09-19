# Spec Delta

## Purpose

Ensure a failed or slow upstream MCP server cannot prevent the local Trellis
Gateway from starting and serving independent built-in capabilities.

## ADDED Requirements

### Requirement: Failed upstream cleanup is bounded

The Gateway SHALL bound cleanup after a failed upstream connection and SHALL
preserve the original connection failure as the reported error.

#### Scenario: Transport close hangs after connect timeout

- **WHEN** an upstream connection times out and its transport close never
  settles
- **THEN** the Gateway returns from the failed connection attempt within the
  cleanup bound and reports the original connection timeout

### Requirement: Built-in Runtime providers survive upstream failure

The Gateway SHALL expose independent built-in Skill and Memory tools even when
one or more upstream MCP servers fail to connect or authenticate.

#### Scenario: Remote MCP timeout during Kimi startup

- **WHEN** a remote upstream exceeds its connection timeout
- **THEN** a Kimi MCP client can still initialize the Trellis Gateway and list
  the built-in Runtime tools without waiting for the failed upstream forever
