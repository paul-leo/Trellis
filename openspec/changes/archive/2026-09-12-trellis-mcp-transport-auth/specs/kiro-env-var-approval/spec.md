## MODIFIED Requirements

### Requirement: Every env var name Trellis writes for Kiro is added to Kiro's own approval list

The Kiro adapter SHALL ensure every env var name declared across the MCP
servers `resolveMcpPlan("kiro", canonical.mcp)` would write into Kiro's
config — both `env` entries and names embedded in `${VAR}`-style
`headers` values — is present in `kiroAgent.mcpApprovedEnvVars`, in
Kiro's global `settings.json` — additive only, never removing an
existing entry. Kiro's own `${VAR}` substitution recurses into `headers`
the same as `env` (verified against its real installed source), so a
header-embedded name needs the identical approval-list entry an `env`
name does.

#### Scenario: A name embedded only in a headers value is approved the same way
- **WHEN** a canonical server (in scope for Kiro) declares
  `headers: { Authorization: "Bearer ${NEW_TOKEN}" }` and no `env` field
- **THEN** `NEW_TOKEN` appears in the computed approved-vars set for
  Kiro, identical to how an `env`-declared name would
