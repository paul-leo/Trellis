# Spec Delta

## Purpose

This capability gives each canonical MCP server an explicit authorization
classification so gateway routing can preserve provider-specific OAuth client
ownership without guessing from network behavior.

## MODIFIED Requirements

### Requirement: OAuth classification is explicit and canonical

The system SHALL accept `auth: oauth` (scalar) or `auth: { kind: oauth,
client_id: <string>, client_secret_env: <string> }` (object; both metadata
keys optional) on a canonical MCP server definition. A scalar and an object
without metadata SHALL carry identical routing behavior. When the field is
absent, the server SHALL retain ordinary MCP routing. The system SHALL NOT
infer OAuth classification from transport, URL, HTTP status, or the presence
of a token file.

#### Scenario: An explicitly OAuth server is classified

- **WHEN** a server definition contains `auth: oauth`
- **THEN** Trellis reports that server as OAuth-classified and applies the
  OAuth direct-routing policy when its Agent route is gateway

#### Scenario: An unclassified HTTP server remains ordinary

- **WHEN** an HTTP server has no `auth` field
- **THEN** Trellis does not classify it as OAuth and preserves the existing
  gateway behavior

#### Scenario: Pre-registered metadata extends an existing scalar

- **WHEN** a server previously configured with `auth: oauth` is changed to
  `auth: { kind: oauth, client_id: "abc" }`
- **THEN** the server's routing is unchanged and the authorization flow uses
  the supplied client identity instead of registering a new client

### Requirement: The CLI manages OAuth classification without secrets

The system SHALL support `trellis mcp set <name> --auth oauth` and
`trellis mcp set <name> --auth none`, with `--dry-run` and `--json` behavior
matching other canonical MCP commands. The command SHALL change only the
classification field and SHALL never print or persist credential values.
`--client-id <value>` SHALL set the pre-registered client identifier (a
public, non-secret literal) and `--client-secret-env <NAME>` SHALL set the
variable name under which a client secret is resolved at authorization time;
the CLI SHALL reject a value that is not a valid variable name in that
position.

#### Scenario: Marking an existing server as OAuth

- **WHEN** the user runs `trellis mcp set figma --auth oauth`
- **THEN** canonical configuration records `auth: oauth` for `figma` and no
  Agent native configuration is changed until `trellis mcp sync` runs

#### Scenario: Clearing OAuth classification

- **WHEN** the user runs `trellis mcp set figma --auth none`
- **THEN** the `auth` field is removed and the server returns to ordinary MCP
  routing on the next sync

#### Scenario: Setting a pre-registered client id

- **WHEN** the user runs `trellis mcp set figma --auth oauth --client-id abc`
- **THEN** canonical configuration records the object form with
  `client_id: abc` and no secret value is written anywhere

#### Scenario: A secret-looking value in the client-id position is refused

- **WHEN** a literal value assigned to any OAuth metadata field matches the
  configured `reject_patterns` or the `client_secret_env` value is not a
  valid variable name
- **THEN** the write is refused with an error explaining the accepted shape,
  and canonical configuration is left unchanged

### Requirement: MCP listing exposes authorization classification

`trellis mcp list` and its JSON form SHALL report whether each canonical MCP
server is OAuth-classified and whether pre-registered client metadata is
present, without resolving or printing any secret.

#### Scenario: JSON listing reports OAuth without credentials

- **WHEN** `figma` is marked `auth: oauth` and has a stored OAuth token
- **THEN** `trellis mcp list --json` includes `auth: oauth` and does not include
  the token value

#### Scenario: JSON listing reports static client presence only

- **WHEN** `figma` carries `auth: { kind: oauth, client_id: "abc" }`
- **THEN** `trellis mcp list --json` reports that pre-registered metadata is
  present and does not echo a client secret or token value

## ADDED Requirements

### Requirement: Pre-registered client metadata drives the authorization flow

`trellis mcp auth <name>` SHALL use pre-registered `client_id` metadata
directly — skipping Dynamic Client Registration — when it is present, running
the same PKCE authorization-code flow. When it is absent, the command SHALL
attempt Dynamic Client Registration as today. When neither path can produce a
client identity, the command SHALL fail with a message naming the
remediation (adding `client_id` under `auth:` in the canonical file). Granted
credentials SHALL be persisted only to the per-server token file, paired with
the client identity used to obtain them.

#### Scenario: A static client reaches an allowlist provider

- **WHEN** `figma` carries `auth: { kind: oauth, client_id: "abc" }` and the
  user runs `trellis mcp auth figma`
- **THEN** the authorization-code flow runs against the provider using
  `abc`, no registration request is made, and the resulting grant is stored
  in the figma token file with `clientId: abc`

#### Scenario: No registration path yields an actionable error

- **WHEN** a provider rejects Dynamic Client Registration
  (`unauthorized_client`) and no `client_id` is configured
- **THEN** `trellis mcp auth` exits non-zero with a message that states the
  provider does not accept new client registrations and points to the
  `auth.client_id` field as the remediation

### Requirement: OAuth client configuration never carries secret values

The canonical schema SHALL NOT provide any field that stores an OAuth client
secret, refresh token, or access token as a literal; secrets enter only as
variable names resolved through the secrets policy, and flow credentials live
only in the per-server token store. Values supplied for OAuth metadata fields
SHALL pass the same literal-value scan (`reject_patterns`) as `static_env`.
Distribution artifacts of the project (schema examples, docs, seed data)
SHALL NOT ship any client identifier obtained by reverse engineering a
provider's official client; only provider-published identifiers may be
pre-filled.

#### Scenario: A pasted secret is refused at load

- **WHEN** canonical configuration contains a value in an OAuth metadata
  field that matches `reject_patterns`
- **THEN** loading refuses the file and reports the offending field without
  printing the value

#### Scenario: Examples ship placeholders only

- **WHEN** the repository's example canonical file demonstrates the object
  form of `auth`
- **THEN** it uses placeholder values and no real provider client identifier
