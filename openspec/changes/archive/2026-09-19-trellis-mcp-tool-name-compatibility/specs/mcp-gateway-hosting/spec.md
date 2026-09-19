# Spec Delta

## MODIFIED Requirements

### Requirement: Tools are aggregated with a server-name prefix and routed back to the correct upstream

The system SHALL expose every upstream tool under a deterministic Agent-safe
name matching `^[a-zA-Z0-9_-]+$` and no longer than 64 characters. An original
tool name MAY be exposed without a server prefix when it is unambiguous and
already safe; otherwise the exposed name SHALL include enough normalized source
identity to remain distinct. The gateway SHALL route the exposed name to the
exact upstream connection and its original tool name, never to a different
server's same-named tool.

#### Scenario: A unique valid tool keeps its short original name

- **WHEN** only server `github` exposes `search_repositories`
- **THEN** the Gateway lists `search_repositories` and routes calls to the
  `github` upstream

#### Scenario: Two upstream servers with same-named tools remain distinguishable

- **WHEN** two upstream servers, `alpha` and `beta`, each expose a tool
  named `search`
- **THEN** the Gateway lists two distinct safe names containing the normalized
  server and tool identity, and both calls route to their respective upstreams

#### Scenario: A tool call is routed to its own upstream, not a same-named one elsewhere

- **WHEN** the Gateway receives the exposed name allocated for `beta`'s
  `search` tool
- **THEN** the call is forwarded to the `beta` upstream connection only,
  never to `alpha`

#### Scenario: Dotted built-in or upstream names are normalized

- **WHEN** an upstream exposes `trellis.skills.search` or `foo.bar`
- **THEN** the Gateway lists a name containing only letters, digits, `_`, or
  `-`, and calling that name reaches the original dotted tool name

#### Scenario: Long tools do not gain an unnecessary prefix

- **WHEN** one upstream exposes a unique tool whose original name is longer
  than the Agent-safe budget
- **THEN** the Gateway exposes a bounded deterministic form of the tool name
  without adding the server prefix, and routes it to the original long name

#### Scenario: Distinct long names remain distinct

- **WHEN** two different upstream tool identities normalize to the same
  bounded visible name
- **THEN** the Gateway assigns deterministic hash/suffix disambiguators, lists
  both tools, and routes each call correctly
