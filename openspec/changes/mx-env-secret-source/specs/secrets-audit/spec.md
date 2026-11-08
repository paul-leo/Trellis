# Spec Delta

## MODIFIED Requirements

### Requirement: Declared env var names with no resolvable value are findings

`trellis secrets audit` SHALL collect every environment entry declared across canonical `mcp.servers[*]` — `env` entries (bare names and `mxenv://` references), `envAliases` sources, and names embedded in `${VAR}`-style `headers` values (deduplicated across servers) — resolve each via `resolveSecretEnv`, and report a `missing-env-value` finding for any delivered name that resolves to `undefined` or an empty string. A malformed `mxenv://` entry SHALL be reported as a finding in its own right rather than skipped or treated as a bare name. This check is agent-agnostic.

#### Scenario: A name embedded only in a headers value is still checked
- **WHEN** a canonical server declares `headers: { Authorization: "Bearer ${SOME_TOKEN}" }` (no `env` field at all) and `resolveSecretEnv` returns `undefined` for `SOME_TOKEN`
- **THEN** the audit reports a `missing-env-value` finding naming `SOME_TOKEN`

#### Scenario: An unresolvable reference is a finding under its delivered name
- **WHEN** a canonical server declares `env: ["mxenv://legacy/NOT_DEFINED_ANYWHERE"]` and the composition does not define `NOT_DEFINED_ANYWHERE`
- **THEN** the audit reports a `missing-env-value` finding naming `NOT_DEFINED_ANYWHERE`

#### Scenario: A malformed reference is a finding
- **WHEN** a canonical server declares `env: ["mxenv://no-slash-segment"]`
- **THEN** the audit reports a finding naming the malformed entry text instead of resolving or ignoring it
