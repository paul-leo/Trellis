## ADDED Requirements

### Requirement: Every env var name Trellis writes for Kiro is added to Kiro's own approval list

The Kiro adapter SHALL ensure every env var name declared across the
MCP servers `resolveMcpPlan("kiro", canonical.mcp)` would write into
Kiro's config is present in `kiroAgent.mcpApprovedEnvVars`, in Kiro's
global `settings.json` (`~/Library/Application Support/Kiro/User/settings.json`
on macOS) — additive only, never removing an existing entry.

#### Scenario: A new env name is appended to an existing approval list
- **WHEN** canonical declares a server (in scope for Kiro) with
  `env: ["NEW_TOKEN"]`, and Kiro's `settings.json` already has
  `kiroAgent.mcpApprovedEnvVars: ["EXISTING_TOKEN"]`
- **THEN** the adapter's plan includes a `"kiro-approved-env-vars"` item
  whose `approvedEnvVars` is `["EXISTING_TOKEN", "NEW_TOKEN"]` — the
  existing entry is preserved, the new one appended

#### Scenario: A server scoped away from Kiro contributes no approved name
- **WHEN** a canonical server's `agents` field is set and does not
  include `"kiro"`
- **THEN** its declared `env` names never appear in the computed
  approved-vars set for Kiro

#### Scenario: A server refused as a known_host_injected collision contributes no approved name
- **WHEN** a canonical server name collides with `known_host_injected`
  (refused by `resolveMcpPlan`, per trellis-mcp-sync-p2)
- **THEN** its declared `env` names never appear in the computed
  approved-vars set for Kiro either

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
