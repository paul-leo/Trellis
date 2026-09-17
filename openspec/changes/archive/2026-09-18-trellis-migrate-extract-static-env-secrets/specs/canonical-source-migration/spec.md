# canonical-source-migration Specification (delta)

## ADDED Requirements

### Requirement: A literal secret found outside `staticEnv` is accepted as ordinary config, never faked into an unresolvable reference

The system SHALL import an MCP server whose `command`, `url`, any
`args` entry, or any `headers` value matches a known-dangerous literal
credential pattern as ordinary literal config, exactly as if no match
had been found — never refused, and never rewritten into a `${VAR}`
reference. This SHALL be unaffected by this capability's `staticEnv`
extraction behavior below — neither a natural, uncontested variable
name (as `staticEnv`'s own dict key provides) nor a `${VAR}` resolution
mechanism proven across every consumer exists for a value embedded in
one of these fields; synthesizing a name and writing a reference
anyway would produce a canonical entry that looks safe but silently
fails to connect for at least some consumers, which is strictly worse
than accepting the literal.

`trellis secrets audit` SHALL also scan canonical's own
`mcp/servers.yaml` against `secrets.policy.yaml`'s `reject_patterns`
(the literal-value check only, not the unexpected-var-name check),
reporting any match with `agent: "canonical"`, so this acceptance is
never silent.

#### Scenario: A literal token embedded in a command argument is accepted
- **WHEN** `trellis migrate --from <agent>` reads a source MCP server
  whose `args` contains a value matching a known credential pattern
- **THEN** the command imports that server normally, canonical's
  `servers.yaml` holds the literal value unchanged, and the run does
  not exit non-zero for this server

#### Scenario: A literal token in a header value is accepted
- **WHEN** a source MCP server's `headers` contains a value matching a
  known credential pattern
- **THEN** the command imports that server normally the same way,
  regardless of any `staticEnv` field on the same definition

#### Scenario: secrets audit flags a literal accepted into canonical
- **WHEN** `trellis secrets audit` runs against a canonical
  `mcp/servers.yaml` containing a literal value matching a
  `reject_patterns` entry, in any of `command`/`url`/`args`/`headers`
- **THEN** the report includes a `literal-secret` finding with
  `agent: "canonical"` naming that file

### Requirement: A literal secret found in `staticEnv` is extracted, not refused

The system SHALL, when a source MCP server's `staticEnv` value matches a
known-dangerous literal credential pattern, extract the real value into
a dotenv-format local secrets file rather than refusing the import: the
canonical `servers.yaml` entry SHALL hold a `${NAME}` reference in place
of the literal (moved from `staticEnv` to `env`), the real value SHALL
be written to that file, and `secrets.policy.yaml` SHALL gain the name
in `allowed_vars` (and `env_file`, if not already set to a different
path). The source agent's own configuration file SHALL NOT be modified
by this or any other part of `trellis migrate`.

`NAME` for a NEW extraction SHALL be synthesized as `TRELLIS_<SERVER>_<KEY>`
(uppercased, non-alphanumeric runs collapsed to `_`) — never the bare
source dict key alone, to avoid colliding with another server's own use
of the same key or with anything already in the user's environment. A
server already extracted under a different naming scheme (including the
bare key alone, from before this scheme existed) SHALL continue to be
recognized as already-migrated by its value — any name already
referenced in canonical's `env` list whose local-secrets-file value
already equals the source's current real value — rather than being
extracted a second time under the current scheme's name.

The real value SHALL NOT appear in any command output, including
`--dry-run` and `--json`, in any circumstance — only the variable name.

#### Scenario: A staticEnv literal secret is extracted on a real run
- **WHEN** `trellis migrate --from kiro --only mcp` imports a real MCP
  server whose `staticEnv` value matches a known credential pattern
- **THEN** canonical's `servers.yaml` entry for that server references
  `${THE_NAME}` (no longer a literal), the real value is written to the
  local secrets file, `secrets.policy.yaml`'s `allowed_vars` includes
  `THE_NAME`, and the run does not exit non-zero for this server

#### Scenario: The source agent's own file is never touched
- **WHEN** a `staticEnv` literal secret is extracted from a real source
  agent's configuration
- **THEN** that source agent's own configuration file is byte-for-byte
  unchanged afterward

#### Scenario: Extraction is idempotent on a re-run with the same value
- **WHEN** `trellis migrate` runs again after a successful extraction,
  and the source agent's real value hasn't changed
- **THEN** the local secrets file is not modified, and the server is
  reported as already extracted, not re-extracted

#### Scenario: A server extracted under an older naming scheme is recognized by value, not re-extracted under the new one
- **WHEN** canonical's `env` list already references a name (any naming
  scheme, including the bare source key alone) whose value in the local
  secrets file already matches the source's current real value
- **THEN** the server is reported as already-migrated, referencing that
  existing name, and no second reference is added under the current
  scheme's synthesized name

#### Scenario: A different value under the same extracted name is a conflict, not an overwrite
- **WHEN** the local secrets file already holds a different value for
  the name being extracted than the source agent's current real value
- **THEN** the command reports a conflict for that name and does not
  overwrite the existing value in the local secrets file

#### Scenario: An already-configured env_file is respected, never repointed
- **WHEN** `secrets.policy.yaml` already has `env_file` set to a path
  other than the default local secrets file
- **THEN** extraction writes the real value into that already-configured
  file instead, and does not change `env_file`

#### Scenario: --dry-run previews the extraction with zero writes and no real value in output
- **WHEN** `trellis migrate --from kiro --only mcp --dry-run` would
  extract a `staticEnv` literal secret
- **THEN** the preview names the variable and the target file the value
  would be written to, the real value does not appear anywhere in that
  output, and no file is modified

#### Scenario: The verdict states the source file still holds the plaintext
- **WHEN** an extraction succeeds as part of a chained `trellis onboard`
  run
- **THEN** the run's verdict includes a warning naming the extracted
  variable and stating that the source agent's own configuration file
  was not modified and may still hold the real value in plaintext
