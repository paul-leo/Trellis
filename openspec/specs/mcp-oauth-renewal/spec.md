# mcp-oauth-renewal Specification

## Purpose
Give stored OAuth credentials a scheduled, non-interactive renewal path so
token expiry is handled — and surfaced — before an Agent session discovers
it as a 401.

## Requirements

### Requirement: Batch renewal of classified OAuth servers

The system SHALL provide `trellis mcp renew`, which iterates every canonical
MCP server carrying an explicit OAuth classification and attempts silent
renewal of its stored token through the same refresh path the gateway uses.
The command SHALL NOT open a browser, SHALL NOT perform an initial
authorization grant, and SHALL NOT touch servers without an explicit OAuth
classification.

#### Scenario: Valid token is a no-op

- **WHEN** an OAuth-classified server has a stored token that is not expired
- **THEN** renew reports it as valid and performs no token-endpoint request

#### Scenario: Expired token with refresh token is renewed

- **WHEN** an OAuth-classified server's stored token is expired and a refresh
  token is present
- **THEN** renew performs the refresh grant, persists the rotated credential,
  and reports the server as refreshed

#### Scenario: Dead credential directs to re-authorization

- **WHEN** a stored credential is expired and refresh fails or no refresh
  token exists
- **THEN** renew reports the server as needing `trellis mcp auth <name>` and
  exits non-zero

#### Scenario: Never-authorized server is a failure, not silence

- **WHEN** an OAuth-classified server has no stored token
- **THEN** renew reports `no-token` with the `trellis mcp auth <name>`
  remediation and exits non-zero

#### Scenario: Unclassified server with a token file is untouched

- **WHEN** a token file exists for a server whose canonical definition has no
  OAuth classification
- **THEN** renew does not include that server in its iteration or output

### Requirement: Dry-run reports without network calls

The command SHALL support `--dry-run`, reporting each server's status —
including `expired-renewable` for expired credentials that hold a refresh
token — without contacting any token endpoint and without writing any token
file.

#### Scenario: Dry-run predicts the refresh set

- **WHEN** one server has a valid token and another has an expired token with
  a refresh token
- **THEN** `trellis mcp renew --dry-run` reports `valid` and
  `expired-renewable` respectively, and no token file changes

### Requirement: Machine-readable output

The command SHALL support `--json`, emitting each server's name and derived
status without any credential material — no access tokens, refresh tokens,
client secrets, or authorization URLs.

#### Scenario: JSON output contains no secrets

- **WHEN** renew runs with `--json` against servers with stored credentials
- **THEN** the output contains server names, statuses, expiry timestamps, and
  remediation strings, and contains no token or secret values

### Requirement: Exit code summarizes credential health

The command SHALL exit `0` when every OAuth-classified server is valid or was
successfully refreshed, and SHALL exit non-zero when any server needs human
re-authorization, has never been authorized, or has an unreadable credential
store entry.

#### Scenario: Scheduler can branch on exit code

- **WHEN** renew runs under a platform scheduler and one server's refresh
  grant is rejected
- **THEN** the process exit code is non-zero and the failing server is named
  in the output

### Requirement: Doctor reports OAuth credential health read-only

`trellis doctor` SHALL include an OAuth section classifying every canonical
OAuth server's stored credential as valid, expired, or absent, without
contacting any token endpoint and without modifying any token file. An
expired or absent credential for a classified server SHALL produce an
`oauth-expired` finding that contributes to a non-zero doctor exit code.

#### Scenario: Doctor surfaces a credential that will 401

- **WHEN** a canonical OAuth server's stored token is expired
- **THEN** `trellis doctor` lists an `oauth-expired` finding naming the
  server, `trellis mcp renew`, and `trellis mcp auth <name>` as remediations,
  and exits non-zero

#### Scenario: Doctor stays read-only

- **WHEN** doctor runs against an expired stored credential
- **THEN** no token-endpoint request is made and the token file is unchanged
  after the run

### Requirement: Scheduler setup is documented

The system SHALL document platform-scheduler installation (launchd on macOS)
for periodic renewal, including a throttle policy that prevents backlog
bursts from repeatedly contacting token endpoints.

#### Scenario: User installs periodic renewal

- **WHEN** the user follows the documented launchd setup
- **THEN** renewal runs on a fixed interval with throttling, writes
  machine-readable output to a log, and concurrent or overlapping runs are
  serialized by the existing per-server refresh lock
