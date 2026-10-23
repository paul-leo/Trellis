# Spec Delta

## ADDED Requirements

### Requirement: The gateway recovers an upstream whose MCP session is invalidated mid-session

When a call to an HTTP/SSE upstream fails because the upstream no longer
recognizes the gateway's MCP session (identified by an HTTP error response
that is not an authentication rejection — anything but 401/403 — whose body
mentions a session, or an enveloped protocol error with code -32000 and a
session-related message), the gateway SHALL reconnect that upstream alone:
establish a fresh session using the same connection logic as startup
(including OAuth credential attachment and header resolution), swap it in
for all subsequent calls, close the stale client only once the fresh
session is serving, and retry the original request once. The recovery
SHALL be single-flight per server — concurrent calls that hit the invalid
session await the same recovery and are retried once against the fresh
session — and SHALL be subject to a cooldown so a repeatedly failing
upstream cannot trigger unbounded reconnect attempts. If recovery fails,
or the retried request fails again, the failure SHALL be confined to that
server's call and the server's status SHALL report a terminal failure
state with `requiresSessionRestart`, while every other upstream and the
gateway itself keep serving. Authentication rejections (401/403) SHALL
NOT enter this recovery path; they remain governed by the OAuth 401
requirement.

#### Scenario: An upstream restart invalidates the session and the call recovers transparently

- **WHEN** an upstream server restarts (or drops its session store) and a
  gateway tool call to it receives a session-not-found rejection
- **THEN** the gateway reconnects that upstream once, establishes a fresh
  MCP session, and the original call succeeds on retry — the agent
  observes no error, and no other upstream reconnects

#### Scenario: Concurrent calls trigger exactly one recovery

- **WHEN** multiple tool calls to the same upstream hit the invalid
  session before a recovery completes
- **THEN** exactly one reconnect occurs for that upstream and every
  waiting call is retried once against the fresh session

#### Scenario: An unrecoverable upstream reaches an honest terminal state

- **WHEN** the recovery reconnect fails, or the retried request fails
  again with a session error, and the cooldown expires without a
  successful recovery
- **THEN** that call fails with an error naming the upstream server, the
  server's status reports a failure with `requiresSessionRestart: true`
  instead of remaining `ready`, and every other upstream keeps serving

#### Scenario: An authentication rejection never triggers reconnection

- **WHEN** an upstream answers 403 with an enveloped error whose code is
  -32000 (the server SDK's authentication-rejection convention)
- **THEN** the gateway does not reconnect; the failure follows the
  existing OAuth 401/authorization isolation behavior

#### Scenario: Recovery composes with OAuth credential resolution

- **WHEN** a Trellis-owned OAuth upstream is reconnected mid-session
- **THEN** the fresh session is established with a validly resolved
  credential (pre-request refresh and 401 retry still apply on the new
  client), and no browser is opened and no credential value is logged

### Requirement: Gateway call errors name the failing upstream server

When a gateway tool call, resource read, or skill lookup fails against a
specific upstream, the returned error SHALL identify that upstream by its
configured server name, so a caller can act on the error without consulting
gateway logs. The aggregated `provider` identity alone SHALL NOT be the
only attribution for upstream-originated failures.

#### Scenario: A failing upstream call reports its server name

- **WHEN** a tool call routed to upstream `github-remote` fails
- **THEN** the error text returned to the caller contains the server name
  `github-remote` alongside the underlying error

### Requirement: A mid-session invalidated upstream never reports a false ready status

While an upstream's session is known to be invalid — whether or not
automatic recovery is available or attempted — the gateway's status for
that server SHALL NOT remain `ready`: it SHALL report the reconnecting
transition while recovery is in progress and a failure state with
`requiresSessionRestart: true` when recovery is not (yet) successful.

#### Scenario: Status reflects recovery in progress

- **WHEN** the gateway is reconnecting an upstream with an invalidated
  session
- **THEN** the server's status reports the reconnecting transition rather
  than `ready`

## MODIFIED Requirements

### Requirement: One upstream's connection failure does not affect any other upstream
The system SHALL log and skip an upstream server that fails to connect or
times out during the gateway's startup aggregation, and SHALL continue
serving every other upstream that connected successfully — a single
failing or slow upstream SHALL NOT prevent the gateway from starting or
from serving already-connected servers' tools. A session invalidation
occurring mid-session SHALL additionally be recoverable per the session
recovery requirement: the affected upstream's tools become unavailable
only while its session is invalid, and no other upstream's tools, status,
or connections SHALL be affected by the invalidation, the recovery
attempt, or its failure.

#### Scenario: A crashed upstream is skipped, others remain available

- **WHEN** one of three configured upstream servers exits immediately on
  spawn
- **THEN** the gateway starts successfully and its `tools/list` response
  contains only the tools of the two upstreams that connected

#### Scenario: A slow upstream times out without blocking the others

- **WHEN** one upstream server does not respond to `initialize` within
  the gateway's connect timeout
- **THEN** that upstream is skipped and every other upstream's
  connection proceeds and completes independently

#### Scenario: A mid-session recovery failure does not disturb other upstreams

- **WHEN** an upstream's session is invalidated mid-session and the
  automatic recovery fails
- **THEN** only that upstream's calls fail; the tool lists, statuses, and
  connections of every other upstream are unchanged

#### Scenario: A reconnected upstream may present a changed tool set

- **WHEN** recovery re-establishes an upstream whose tool set changed
  while its session was down
- **THEN** the gateway swaps the upstream's tool registrations to the
  fresh set (renaming collisions resolved deterministically), the next
  `tools/list` reflects the fresh set, and previously listed exposed names
  that no longer exist are rejected as unknown tools without affecting
  other upstreams' names beyond deterministic collision resolution
