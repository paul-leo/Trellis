# pi-bridge-lifecycle Specification

## Purpose
TBD - created by archiving change pi-bridge-lifecycle. Update Purpose after archive.
## Requirements
### Requirement: The pi bridge owns connected MCP client lifecycles

The bridge SHALL track every MCP client it successfully connects and SHALL
close all tracked clients when pi emits `session_shutdown`. Cleanup SHALL be
idempotent and best-effort, and it SHALL NOT close clients belonging to any
other process or extension.

#### Scenario: Pi session shutdown closes a stdio MCP child

- **WHEN** the bridge connects to a stdio MCP server and pi emits
  `session_shutdown`
- **THEN** the bridge closes the corresponding MCP client and the server's
  stdio child process is released

#### Scenario: Multiple servers are all cleaned up

- **WHEN** the bridge connects to multiple MCP servers and pi emits
  `session_shutdown`
- **THEN** every client created by this bridge receives cleanup, even if one
  client's close operation fails

#### Scenario: Shutdown cleanup is idempotent

- **WHEN** pi emits `session_shutdown` more than once
- **THEN** each client is closed at most once and no duplicate cleanup error is
  surfaced

### Requirement: Failed tool discovery does not leak a connected client

When an MCP connection succeeds but `tools/list` fails, the bridge SHALL close
that client before continuing with other configured servers. It SHALL retain
the existing behavior of logging the server-specific failure and continuing
without registering tools from that server.

#### Scenario: Tool listing fails after connection

- **WHEN** a connected MCP server rejects or fails its `tools/list` request
- **THEN** the bridge closes that server client, logs the failure, and does not
  prevent other servers from registering tools

#### Scenario: A server that never connects is not cleaned twice

- **WHEN** an MCP server fails during initial connection
- **THEN** the bridge logs the connection failure and does not attempt client
  cleanup for a client that was never created

