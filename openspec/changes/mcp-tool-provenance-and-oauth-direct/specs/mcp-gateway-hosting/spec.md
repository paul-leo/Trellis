# Spec Delta

## ADDED Requirements

### Requirement: Resold tool metadata identifies its upstream source
The Gateway SHALL annotate every resold upstream tool's metadata so an
Agent can identify the owning server without relying on the tool name
alone. The annotation SHALL name the canonical server (e.g. a
`Source: <server>` line in the tool description) and SHALL be added without
removing or altering the upstream's own description text.

#### Scenario: Resold tool description names its server
- **WHEN** the `sentry` upstream exposes a tool whose description is
  "Search issues"
- **THEN** the Gateway lists the tool with its prefixed name and a
  description that still contains "Search issues" and additionally names
  `sentry` as the source

#### Scenario: OAuth servers delivered natively carry no gateway annotation
- **WHEN** an OAuth-classified server is delivered to an Agent as a native
  entry rather than through the gateway
- **THEN** the gateway adds no annotation to it; the Agent's own client
  naming already identifies the server

#### Scenario: Built-in runtime tools carry no source annotation
- **WHEN** the Runtime provider exposes its own built-in tools
- **THEN** the gateway does not add upstream-source annotations to them
