# Spec Delta

## Purpose

This capability reports, for each OAuth-classified MCP server, what Trellis's
own credential store knows, so a person can tell "never authorized" from "needs
refresh" without reading files.

## ADDED Requirements

### Requirement: Listing reports credential state for OAuth-classified servers

`trellis mcp list` and its JSON form SHALL report, for each server classified
`auth: oauth` in either form, an `authStatus` of `not-authorized`, `authorized`,
`refreshable`, or `expired`, and SHALL include `authExpiresAt` (epoch
milliseconds) when the stored token has an expiry. A server with no OAuth
classification SHALL carry neither field.

#### Scenario: No stored token

- **WHEN** `figma` is classified OAuth and has no token file
- **THEN** its entry reports `authStatus: not-authorized` and no expiry

#### Scenario: A valid token

- **WHEN** the stored token is not expired
- **THEN** the entry reports `authorized` with the token's `authExpiresAt`

#### Scenario: Expired but renewable

- **WHEN** the stored access token is expired and a refresh token is stored
- **THEN** the entry reports `refreshable`

#### Scenario: Expired and not renewable

- **WHEN** the stored access token is expired and no refresh token is stored
- **THEN** the entry reports `expired`

### Requirement: Credential state is never inferred and never exposes a secret

The system SHALL derive credential state only from the per-server token store and
only for servers explicitly classified as OAuth; a token file for an unclassified
server SHALL NOT cause that server to be reported as OAuth. The listing SHALL NOT
contain an access token, refresh token, client secret, or client identifier, and
the human-readable form SHALL NOT print them either.

#### Scenario: A stray token file does not reclassify a server

- **WHEN** a token file exists for a server that has no `auth` field
- **THEN** the server is listed without `authStatus`

#### Scenario: JSON output carries no credential material

- **WHEN** `trellis mcp list --json` runs with an authorized server
- **THEN** the output contains the state and expiry but no token, secret, or id

### Requirement: Credential state is not presented as connection health

The system SHALL label the field as credential state wherever it is displayed
and SHALL NOT use it to claim the server is reachable or working.

#### Scenario: Authorized does not mean healthy

- **WHEN** a server is `authorized` but its endpoint is unreachable
- **THEN** the GUI shows the credential badge as authorized and makes no claim
  about reachability

### Requirement: An unauthorized server shows the remedy, not a hidden flow

The GUI SHALL show, for a server whose state is `not-authorized` or `expired`,
the command `trellis mcp auth <name>`, and SHALL NOT start an authorization flow
itself.

#### Scenario: Remedy is displayed

- **WHEN** `figma` is `not-authorized`
- **THEN** its card shows `trellis mcp auth figma`
