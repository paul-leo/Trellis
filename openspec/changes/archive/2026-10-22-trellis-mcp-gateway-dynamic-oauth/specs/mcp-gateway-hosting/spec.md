# Spec Delta

## MODIFIED Requirements

### Requirement: An expired OAuth token is refreshed silently, without user interaction
The system SHALL, when a stored OAuth token is expired or about to
expire, attempt a `refresh_token` grant automatically — inside the
gateway subcommand at connect time, before each outbound request to that
server while the gateway is running, or inside `trellis mcp auth` when
re-run — without requiring a browser, a callback listener, or any user
interaction, and SHALL persist the refreshed token back to that server's
OAuth file. The gateway's "about to expire" window SHALL be measured in
minutes (not seconds) so that a request passing the freshness check does
not carry a token that dies mid-flight.

#### Scenario: The gateway silently refreshes an expired token before connecting
- **WHEN** the gateway subcommand starts and a server's stored OAuth
  token is past its expiry
- **THEN** the gateway performs a `refresh_token` grant, persists the
  new access token, and proceeds to connect using it — with no browser
  opened and no user prompt

#### Scenario: A request on a nearly-expired token refreshes first
- **WHEN** a tool call arrives whose stored access token is within the
  gateway's early-refresh window
- **THEN** the gateway refreshes and persists the token before sending
  the request, and the call proceeds with the new token — without user
  interaction

#### Scenario: A refresh failure is treated as a connection failure, not a crash
- **WHEN** a `refresh_token` grant itself fails (e.g. the refresh token
  has also expired)
- **THEN** the gateway skips that upstream server per the
  connection-failure requirement, and does not open a browser to attempt
  re-authorization on its own

#### Scenario: Explicit authorization recovers from a rejected refresh grant
- **WHEN** the user runs `trellis mcp auth <name>` and the stored token's
  refresh grant is rejected with OAuth `invalid_grant`
- **THEN** the command starts a new browser authorization without requiring
  `--force`, and replaces the stored credential only after authorization
  succeeds; cancelling leaves the prior credential file unchanged

#### Scenario: A temporary refresh failure does not start another login
- **WHEN** the user runs `trellis mcp auth <name>` and refreshing fails due
  to a network error, rate limit, temporary provider outage, or a structured
  OAuth error other than `invalid_grant`
- **THEN** the command reports the error and exits non-zero without opening
  a browser or replacing the stored credential

## ADDED Requirements

### Requirement: OAuth credentials take effect on the next request without restart
For a Trellis-owned OAuth HTTP upstream, the gateway SHALL resolve the
authorization credential from that server's stored OAuth file at each
outbound request, not fix it once at connect time. A credential written
by any process — including `trellis mcp auth` run in another terminal —
SHALL therefore affect the very next request of an already-running
gateway, with no gateway restart and no new agent session. An explicit
`Authorization` header configured in canonical for that server SHALL
continue to take precedence over the stored credential.

#### Scenario: Mid-session re-authorization is picked up immediately
- **WHEN** a running gateway holds a dead stored credential for a server
  and the user completes `trellis mcp auth <name>` in another terminal
- **THEN** the gateway's next tool call on that server uses the newly
  written credential and succeeds, without restarting the gateway or the
  agent session

#### Scenario: A session outlives the access token lifetime
- **WHEN** an agent session runs longer than a server's access token
  lifetime and keeps calling that server's tools
- **THEN** the calls continue to succeed, because each request resolves
  the credential anew and refreshes under the existing per-server
  serialization when the stored token is within the early-refresh window

### Requirement: A mid-session 401 retries once after a forced refresh, isolated per server
When a Trellis-owned OAuth upstream answers 401 to a gateway request,
the gateway SHALL force one credential refresh (bypassing the expiry
check, still under the per-server lock and rotation semantics) and retry
the request once. If the forced refresh fails or the retried request is
rejected again, the failure SHALL be confined to that server's call: the
caller receives an error naming the server and the `trellis mcp auth`
remediation, the server's gateway status is marked as needing
authorization, and every other upstream and the gateway itself SHALL
keep serving. A refresh failure during pre-request credential resolution
SHALL NOT abort the request pipeline — the request proceeds with the
previous credential so the 401 path decides the outcome.

#### Scenario: A revoked-but-unexpired token recovers transparently
- **WHEN** the provider revokes an access token before its recorded
  expiry and a tool call returns 401
- **THEN** the gateway force-refreshes, retries the request once, and the
  call succeeds — the agent observes no error

#### Scenario: A dead grant isolates to one server
- **WHEN** the forced refresh is rejected (OAuth `invalid_grant`)
- **THEN** that call fails with an error carrying the
  `trellis mcp auth <name>` remediation, the server's status reports
  needs-auth, tools of every other server keep working, and no browser
  is opened

#### Scenario: Pre-request refresh errors never crash the gateway
- **WHEN** the pre-request refresh attempt fails (network error or a
  rejected grant)
- **THEN** the gateway does not throw out of the request path; the
  request is sent with the previous credential and the 401/rejection
  path determines the outcome
