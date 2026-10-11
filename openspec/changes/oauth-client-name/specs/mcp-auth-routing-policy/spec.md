# Spec deltas

## MODIFIED Requirements

### Requirement: OAuth classification is explicit and canonical

The system SHALL accept `auth: oauth` on a canonical MCP server definition.
When the field is absent, the server SHALL retain ordinary MCP routing. The
system SHALL NOT infer OAuth classification from transport, URL, HTTP status,
or the presence of a token file.

The object form `{ kind: oauth, owner?, client_id?, client_secret_env?,
client_name? }` SHALL be accepted with the same classification semantics;
unknown keys SHALL be refused at load with an error that names the key but
never echoes its value. `client_name` is a public, self-asserted display name
for providers that gate dynamic client registration by client name; it is
not a credential and SHALL NOT be routed through the secrets policy.

#### Scenario: An explicitly OAuth server is classified

- **WHEN** a server definition contains `auth: oauth`
- **THEN** Trellis reports that server as OAuth-classified and applies the
  OAuth direct-routing policy when its Agent route is gateway

#### Scenario: An unclassified HTTP server remains ordinary

- **WHEN** an HTTP server has no `auth` field
- **THEN** Trellis does not classify it as OAuth and preserves the existing
  gateway behavior

#### Scenario: A client name is carried without changing classification

- **WHEN** a server definition contains `auth: { kind: oauth, client_name: "Claude Code" }`
- **THEN** the server is OAuth-classified exactly as the scalar form, the
  client name round-trips through canonical load and save, and ownership
  stays agent-managed unless `owner: trellis` is also present

#### Scenario: An invalid client name is refused without echoing it

- **WHEN** a server definition contains a non-string `client_name`
- **THEN** loading fails with an error naming `auth.client_name`
