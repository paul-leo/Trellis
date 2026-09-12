# kiro-env-var-approval Specification

## Purpose
TBD - created by archiving change trellis-kiro-approved-env-vars. Update Purpose after archive.
## Requirements
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

### Requirement: The settings.json write preserves every unrelated key

Applying a `"kiro-approved-env-vars"` plan item SHALL parse the whole
`settings.json`, spread every existing top-level key through unchanged,
and modify only the `kiroAgent.mcpApprovedEnvVars` key.

#### Scenario: Unrelated editor settings survive the write
- **WHEN** `settings.json` contains unrelated keys (e.g.
  `"editor.fontSize": 14`) alongside or absent any
  `kiroAgent.mcpApprovedEnvVars` key
- **THEN** after applying, every one of those unrelated keys is present
  with its original value, unchanged

#### Scenario: A file that fails to parse produces a conflict, never a silent overwrite
- **WHEN** `settings.json` exists but is not valid JSON
- **THEN** the adapter reports a `"conflict"` plan item for this write
  and does not modify the file

### Requirement: Already-correct state produces no plan item (idempotent)

`plan()` SHALL NOT produce a `"kiro-approved-env-vars"` item at all if
every env var name Trellis would write for Kiro is already present in
`kiroAgent.mcpApprovedEnvVars`.

#### Scenario: Re-running against an already-correct machine is a no-op
- **WHEN** `kiroAgent.mcpApprovedEnvVars` already contains every name
  Trellis's current canonical MCP config would need for Kiro
- **THEN** `plan()` produces zero `"kiro-approved-env-vars"` items

