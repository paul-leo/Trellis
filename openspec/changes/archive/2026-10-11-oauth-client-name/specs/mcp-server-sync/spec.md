# Spec deltas

## ADDED Requirements

### Requirement: pi native entries carry the declared OAuth client name

When a canonical http server declares `auth.client_name`, the pi adapter
SHALL render the entry's `oauth.clientName` field — the same shape
`pi mcp add --oauth-client-name` writes — so that providers gating dynamic
client registration by client name (e.g. Figma) accept the registration, and
so that subsequent syncs compare equal instead of stripping the field.
Servers without a declared `client_name` SHALL render unchanged.

#### Scenario: A named client registration survives sync

- **WHEN** figma declares `auth: { kind: oauth, client_name: "Claude Code" }`
  and pi ≥ 1.1.0 is managed
- **THEN** sync writes `{ "url": "...", "oauth": { "clientName": "Claude Code" } }`,
  `pi mcp login figma` registers under that name, and the next sync reports
  no drift

#### Scenario: An unnamed OAuth server stays bare

- **WHEN** an agent-owned OAuth server has no `client_name`
- **THEN** the pi entry remains `{ "url": "..." }` and `pi mcp login`
  registers under pi's default client name
