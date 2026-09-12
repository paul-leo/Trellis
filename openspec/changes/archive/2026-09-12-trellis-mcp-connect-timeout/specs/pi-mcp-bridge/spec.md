## ADDED Requirements

### Requirement: A hanging server's connect attempt cannot stall the bridge or block other servers

Each of `connectStdio`/`connectHttp`/`connectSse` SHALL bound its
`client.connect()` call with a fixed timeout (10 seconds). A server
whose connection neither resolves nor rejects within that window SHALL
be treated identically to one whose `connect()` call rejected outright:
logged and skipped, with every other configured server's connection and
tool registration proceeding unaffected.

#### Scenario: A server that never answers the initialize handshake is skipped, not fatal
- **WHEN** a stdio server's process stays alive but never writes a
  response to its `initialize` request
- **THEN** the bridge logs a connection failure for that server after
  the timeout elapses, and does not register any tools for it

#### Scenario: One server timing out does not prevent another server's tools from registering
- **WHEN** one configured server hangs on connect and a second,
  independent server connects and responds normally
- **THEN** the second server's tools are registered exactly as if the
  first server were not configured at all

#### Scenario: `listTools()` hanging after a successful connect is treated the same way
- **WHEN** a server answers `initialize` successfully but its
  `tools/list` response never arrives
- **THEN** the bridge logs a failure for that server after the timeout
  elapses, closes its client connection, and registers no tools for it,
  without affecting any other server
