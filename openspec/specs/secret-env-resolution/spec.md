# secret-env-resolution Specification

## Purpose
TBD - created by archiving change trellis-secrets-env-management. Update Purpose after archive.
## Requirements
### Requirement: A shared resolver is the single source of truth for a declared name's value

The system SHALL provide one function, `resolveSecretEnv(names, policy)`,
used by both the pi bridge and `trellis secrets audit`, so
that the two can never disagree about where a declared environment
variable name's value comes from.

#### Scenario: Both consumers resolve the same name identically
- **WHEN** the pi bridge and `trellis secrets audit` each resolve the
  same variable name against the same `secrets.policy.yaml`
- **THEN** both receive the identical value (or both receive
  `undefined`) — there is no separate resolution logic in either call
  site

### Requirement: `env_file` is optional and sole-source when set

`secrets.policy.yaml` SHALL support an optional `env_file` field naming a
dotenv-format file. When set, `resolveSecretEnv` SHALL read every
requested name from that file only — never falling back to
`process.env` for a name absent from it. When `env_file` is unset,
`resolveSecretEnv` SHALL read directly from `process.env`, unchanged from
pre-existing behavior.

#### Scenario: A name present in env_file resolves from that file
- **WHEN** `secrets.policy.yaml` sets `env_file` to a path, and that file
  contains `SOME_TOKEN=value`
- **THEN** `resolveSecretEnv(["SOME_TOKEN"], policy)` returns
  `{ SOME_TOKEN: "value" }`, regardless of what `process.env.SOME_TOKEN`
  is set to in the calling process

#### Scenario: A name absent from env_file never falls back to ambient env
- **WHEN** `env_file` is set and does not contain `OTHER_TOKEN`, but
  `process.env.OTHER_TOKEN` is set in the calling process
- **THEN** `resolveSecretEnv(["OTHER_TOKEN"], policy)` returns
  `{ OTHER_TOKEN: undefined }` — the ambient value is never consulted

#### Scenario: No env_file preserves today's ambient-only behavior
- **WHEN** `secrets.policy.yaml` has no `env_file` field
- **THEN** `resolveSecretEnv(names, policy)` reads each name
  directly from `process.env`, exactly as every pre-existing caller did
  before this change

### Requirement: env_file parsing is narrow and dependency-free

The `env_file` parser SHALL handle exactly `KEY=VALUE` lines, skipping
blank lines and lines starting with `#`. It SHALL NOT attempt quoting,
escaping, multiline values, or shell-style interpolation — a value
requiring any of those is out of scope, not silently mishandled.

#### Scenario: A simple KEY=VALUE line parses correctly
- **WHEN** `env_file` contains the line `MCPR_TOKEN=abc123`
- **THEN** the parsed map contains `{ MCPR_TOKEN: "abc123" }`

#### Scenario: Comment and blank lines are skipped
- **WHEN** `env_file` contains a line starting with `#` and a blank line
  interleaved with `KEY=VALUE` lines
- **THEN** neither contributes an entry to the parsed map, and the real
  `KEY=VALUE` lines are unaffected

