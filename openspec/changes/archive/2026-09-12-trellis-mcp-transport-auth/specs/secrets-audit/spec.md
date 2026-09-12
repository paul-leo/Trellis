## MODIFIED Requirements

### Requirement: Env var names outside the allow-list are findings
The audit SHALL extract every environment variable **name** each agent's
real config file declares — JSON `env` object keys plus names embedded
in `${VAR}`-style `headers` object *values* for Claude Code/Kiro; TOML
`env_vars` array entries plus a `bearer_token_env_var` value for Codex —
and report a finding for any name not present in
`secretsPolicy.allowedVars`.

#### Scenario: A wrong/unexpected variable name is caught
- **WHEN** `~/.codex/config.toml` declares `env_vars = ["GITLAB_TOKEN"]`
  for a server, but `secretsPolicy.allowedVars` only lists
  `GITLAB_PERSONAL_ACCESS_TOKEN`
- **THEN** the audit reports a finding naming `GITLAB_TOKEN` as an
  unexpected variable name in that file

#### Scenario: A name embedded in a headers value is caught the same way
- **WHEN** `~/.claude.json` declares
  `"headers": {"Authorization": "Bearer ${UNAPPROVED_TOKEN}"}` for a
  server, and `UNAPPROVED_TOKEN` is not in `secretsPolicy.allowedVars`
- **THEN** the audit reports a finding naming `UNAPPROVED_TOKEN`,
  identical in kind to an unexpected `env` name

#### Scenario: A Codex bearer_token_env_var name is checked the same way
- **WHEN** `~/.codex/config.toml` declares
  `bearer_token_env_var = "UNAPPROVED_TOKEN"` for a server, and that name
  is not in `secretsPolicy.allowedVars`
- **THEN** the audit reports a finding naming `UNAPPROVED_TOKEN`

#### Scenario: A declared name matching the allow-list produces no finding
- **WHEN** every environment variable name declared across all present
  agents' real config files (including names inside `headers` values and
  Codex's `bearer_token_env_var`) appears in `secretsPolicy.allowedVars`
- **THEN** the audit reports zero unexpected-name findings

### Requirement: Declared env var names with no resolvable value are findings

`trellis secrets audit` SHALL collect every environment variable name
declared across canonical `mcp.servers[*]` — both `env` entries and
names embedded in `${VAR}`-style `headers` values (deduplicated across
servers) — resolve each via `resolveSecretEnv`, and report a
`missing-env-value` finding for any name that resolves to `undefined` or
an empty string. This check is agent-agnostic.

#### Scenario: A name embedded only in a headers value is still checked
- **WHEN** a canonical server declares
  `headers: { Authorization: "Bearer ${SOME_TOKEN}" }` (no `env` field
  at all) and `resolveSecretEnv` returns `undefined` for `SOME_TOKEN`
- **THEN** the audit reports a `missing-env-value` finding naming
  `SOME_TOKEN`
