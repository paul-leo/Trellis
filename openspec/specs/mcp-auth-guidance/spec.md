# mcp-auth-guidance Specification

## Purpose
TBD - created by archiving change trellis-mcp-status-credential-health. Update Purpose after archive.

## Requirements

### Requirement: Upstream status carries a structured tool count

Each `ready` upstream status SHALL include a numeric `toolCount` field
equal to the number of tools that upstream contributed at connect time.
The human-readable `detail` string SHALL be retained unchanged for
existing consumers.

#### Scenario: Agent inspects a healthy upstream

- **WHEN** an upstream connected successfully and contributed N tools
- **THEN** its status entry contains `toolCount: N` alongside the
  existing `detail` text

#### Scenario: Degraded router upstream

- **WHEN** the mcp-router upstream connects but exposes no downstream
  tools
- **THEN** its status entry reports `toolCount: 0` with the existing
  `degraded` status and router remediation

### Requirement: Status reports OAuth-classified server credential health

`trellis.mcp.status` SHALL include an `oauth` array with one entry per
OAuth-classified canonical server in scope for the calling agent — the
same set that is written as direct native entries — reporting the stored
credential's health as a `credential` field with the shared classifier's
status vocabulary, plus `expiresAt` (ISO 8601) when known and a
`remediation` naming `trellis mcp renew` or `trellis mcp auth <name>`
when action is needed. The field SHALL NOT be named `status`: the
gateway cannot observe a direct-routed server's connection state, only
its stored credential.

#### Scenario: Agent asks about a never-authorized OAuth server

- **WHEN** an OAuth-classified server is in scope and no token is stored
- **THEN** the `oauth` entry reports `credential: "no-token"` with a
  remediation naming `trellis mcp auth <name>`

#### Scenario: Agent asks about a healthy OAuth server

- **WHEN** an OAuth-classified server has a stored, unexpired token
- **THEN** the entry reports `credential: "valid"` with `expiresAt` and
  no remediation

#### Scenario: Expired but renewable credential

- **WHEN** the stored token is expired and carries a refresh token
- **THEN** the entry reports `credential: "expired-renewable"` with a
  remediation naming `trellis mcp renew`

### Requirement: Credential reporting is read-only and secret-free

The `oauth` section SHALL be computed from the token store alone: no
token-endpoint contact, no refresh attempt, no writes. No token value,
refresh token, or other secret material SHALL appear in any field.

#### Scenario: Output audit

- **WHEN** `trellis.mcp.status` is called with OAuth-classified servers
  in scope
- **THEN** the output contains no access-token or refresh-token values,
  and the token files on disk are unmodified
