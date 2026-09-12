## ADDED Requirements

### Requirement: Declared env var names with no resolvable value are findings

`trellis secrets audit` SHALL collect every environment variable name
declared across canonical `mcp.servers[*].env` (deduplicated across
servers), resolve each via `resolveSecretEnv` (from
`secret-env-resolution`), and report a `missing-env-value` finding for
any name that resolves to `undefined` or an empty string. This check is
agent-agnostic — it is not scoped to any single agent's config file, and
runs even when a server is scoped away from every present agent.

#### Scenario: A declared name with no resolvable value is a finding
- **WHEN** a canonical server declares `env: ["SOME_TOKEN"]` and
  `resolveSecretEnv` returns `undefined` for `SOME_TOKEN`
- **THEN** the audit reports a `missing-env-value` finding naming
  `SOME_TOKEN`

#### Scenario: A resolvable name produces no finding
- **WHEN** every name declared across `mcp.servers[*].env` resolves to a
  non-empty value
- **THEN** the audit reports zero `missing-env-value` findings

#### Scenario: No canonical MCP servers means no missing-env-value findings
- **WHEN** `mcp.servers` is empty (no `~/.trellis/mcp/servers.yaml`, or
  an empty one)
- **THEN** the audit reports zero `missing-env-value` findings — there
  is nothing declared to check

## MODIFIED Requirements

### Requirement: Any finding fails the command non-zero
`trellis secrets audit` SHALL exit with a non-zero code if the combined
findings list (literal-value + unexpected-name + missing-env-value,
across every present agent and every canonical MCP server) is non-empty,
and SHALL exit zero when it is empty. The audit SHALL NOT modify any
file it reads, and SHALL NOT modify `env_file` if `secrets.policy.yaml`
sets one.

#### Scenario: Any finding at all yields a non-zero exit
- **WHEN** at least one finding of any kind exists
- **THEN** `trellis secrets audit` exits with code 1

#### Scenario: No findings yields a zero exit
- **WHEN** every present agent's real config file passes both file-based
  checks and every canonical env name resolves to a value
- **THEN** `trellis secrets audit` exits with code 0

#### Scenario: The audit never writes anything
- **WHEN** `trellis secrets audit` runs against any agent's real config
  file or any `env_file`, finding or no finding
- **THEN** those files' bytes on disk are unchanged after the run
