# secrets-audit Specification

## Purpose
TBD - created by archiving change trellis-secrets-audit-p3. Update Purpose after archive.
## Requirements
### Requirement: Secrets audit scans real, on-disk agent output
`trellis secrets audit` SHALL read each present, MCP-capable agent's
actual configuration file from disk (`~/.claude.json` for Claude Code,
`~/.codex/config.toml` for Codex, `~/.kiro/settings/mcp.json` for Kiro) —
never the canonical source — and evaluate it against
`CanonicalSource.secretsPolicy`. An agent that is not present SHALL be
skipped, not reported as a finding.

#### Scenario: A present agent's real config file is read directly
- **WHEN** Claude Code is present and `~/.claude.json` exists on disk
- **THEN** the audit reads that file's actual current bytes, not a
  regenerated or canonical-derived version of it

#### Scenario: An absent agent produces no findings
- **WHEN** Kiro is not present on this machine
- **THEN** the audit produces zero findings for Kiro and does not attempt
  to read `~/.kiro/settings/mcp.json`

### Requirement: Literal-credential-shaped values are findings
The audit SHALL scan each agent's real config file's full text against
every pattern in `secretsPolicy.rejectPatterns` and report a finding for
each match, regardless of which part of the file the match falls in or
who wrote that content.

#### Scenario: A literal credential value embedded in a generated config is caught
- **WHEN** `~/.claude.json` contains a string matching one of
  `secretsPolicy.rejectPatterns` (e.g. a GitLab PAT literal)
- **THEN** the audit reports a finding identifying the agent, the file,
  and which pattern matched

#### Scenario: A ${VAR} reference never trips the literal-value check
- **WHEN** every `env` value in `~/.claude.json` is a `${VAR}`-style
  reference, none matching any `reject_patterns` entry
- **THEN** the audit reports no literal-value findings for that file

### Requirement: Env var names outside the allow-list are findings
The audit SHALL extract every environment variable **name** each agent's
real config file declares for its MCP servers (JSON `env` object keys for
Claude Code/Kiro; TOML `env_vars` array entries for Codex) and report a
finding for any name not present in `secretsPolicy.allowedVars`.

#### Scenario: A wrong/unexpected variable name is caught
- **WHEN** `~/.codex/config.toml` declares `env_vars = ["GITLAB_TOKEN"]`
  for a server, but `secretsPolicy.allowedVars` only lists
  `GITLAB_PERSONAL_ACCESS_TOKEN`
- **THEN** the audit reports a finding naming `GITLAB_TOKEN` as an
  unexpected variable name in that file

#### Scenario: A declared name matching the allow-list produces no finding
- **WHEN** every environment variable name declared across all present
  agents' real config files appears in `secretsPolicy.allowedVars`
- **THEN** the audit reports zero unexpected-name findings

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

