# canonical-source-migration Specification

## Purpose
`trellis migrate --from <agent>` — imports an existing agent's real
skills, instructions, and MCP servers into canonical source, one
category at a time or all at once via `--only`. Never overwrites
differing content; reports a conflict instead. Created by archiving
change trellis-cli-migrate; extended by trellis-migrate-category-
selection (`--only`) and trellis-migrate-mcp-servers (MCP servers).

## Requirements

### Requirement: `trellis migrate --from <agent>` imports an existing agent's real skills into canonical source

The system SHALL read the named agent's current `AgentSnapshot` and, for
each of its skills, copy the skill's real content into
`~/.trellis/skills/<name>/` unless that skill is a symlink (shared in
from elsewhere, not this agent's own content) or is marked
case-broken by `agent-state-probing`'s own detection. It SHALL refuse
to run against an agent that isn't present on this machine. An optional
`--only skills|instructions` flag restricts the run to just that one
category; omitting it plans both categories, exactly as before this
flag existed. This requirement's skill-copying behavior applies only
when skills are in scope for the run (no `--only`, or `--only skills`).

#### Scenario: A real, non-symlinked skill is copied in
- **WHEN** the named agent has a skill that is an ordinary directory
  (not a symlink) and canonical source has no skill of that name yet
- **THEN** `~/.trellis/skills/<name>/` is created with that skill's
  real file content

#### Scenario: A symlinked skill is skipped, not copied
- **WHEN** the named agent's skill entry has `isSymlink: true`
- **THEN** that skill is not copied into canonical source, and the
  command's output names it as skipped and why

#### Scenario: A case-broken skill is skipped, not copied
- **WHEN** the named agent's skill entry has `caseCorrect: false`
- **THEN** that skill is not copied into canonical source, and the
  command's output names it as skipped and why

#### Scenario: Migrating from an absent agent refuses immediately
- **WHEN** `trellis migrate --from <agent>` runs and that agent's own
  probe reports `present: false`
- **THEN** the command refuses with a clear message and performs no
  writes

#### Scenario: `--only instructions` excludes every skill from the plan
- **WHEN** `trellis migrate --from <agent> --only instructions` runs
- **THEN** the plan contains no skill items at all — not even a
  `conflict` or `already-migrated` entry for a skill that would
  otherwise have one — and no skill directory under
  `~/.trellis/skills/` is created, modified, or read for comparison

### Requirement: Migration never silently overwrites differing content

For both skills and instructions, the system SHALL compare the source
agent's real content against what's already in canonical source (if
anything) before writing. Identical content is a no-op (already
migrated). Different content is a conflict: reported, not overwritten.

#### Scenario: Re-running migrate after a successful migration is a no-op
- **WHEN** `trellis migrate --from <agent>` runs again after a prior
  successful migration of the same skill, and the source content hasn't
  changed
- **THEN** that skill is reported as already migrated, and its
  canonical directory is not modified

#### Scenario: A skill that already exists in canonical with different content is a conflict
- **WHEN** canonical source already has a skill of the same name whose
  content differs, byte for byte, from the source agent's version
- **THEN** the command reports a conflict for that skill and does not
  overwrite the existing canonical content

### Requirement: Instructions migrate only into an empty or still-placeholder agents.md

The system SHALL import the source agent's real instructions file
content into `~/.trellis/agents.md` only when that file doesn't exist
yet, or exists with content identical to `trellis init`'s own generated
placeholder. Any other existing content is a conflict, reported and
left untouched. This requirement applies only when instructions are in
scope for the run (no `--only`, or `--only instructions`).

#### Scenario: A placeholder agents.md is replaced with real content
- **WHEN** `~/.trellis/agents.md` exists with exactly `trellis init`'s
  generated placeholder content
- **THEN** migrating instructions from a present agent replaces it with
  that agent's real instructions content

#### Scenario: Real, pre-existing agents.md content is a conflict, not overwritten
- **WHEN** `~/.trellis/agents.md` exists with content other than the
  placeholder (hand-authored, or from a prior migration)
- **THEN** the command reports a conflict for instructions and leaves
  the existing file untouched

#### Scenario: `--only skills` excludes instructions from the plan
- **WHEN** `trellis migrate --from <agent> --only skills` runs
- **THEN** the plan contains no instructions item at all, and
  `~/.trellis/agents.md` is neither read for comparison nor written

### Requirement: Migrated content is not scoped to the source agent

The system SHALL NOT write any `scope.yaml` entry restricting migrated
skills or instructions to the source agent — migrated content is shared
across all present agents by default, the same as any other canonical
content with no explicit scope.

#### Scenario: A migrated skill is unscoped
- **WHEN** a skill is migrated from Codex into canonical source
- **THEN** no `scope.yaml` entry is created for it, and it is available
  to every present agent on the next `trellis sync`

### Requirement: `--dry-run` previews the migration plan without writing anything

The system SHALL support a `--dry-run` flag that computes and prints
the same create/skip/conflict/already-migrated plan the real run would
produce, without creating, modifying, or deleting any file.

#### Scenario: Dry run reports the plan with zero filesystem writes
- **WHEN** `trellis migrate --from <agent> --dry-run` runs
- **THEN** the output names every skill and the instructions file with
  their planned action, and no file under `~/.trellis/` is created,
  modified, or deleted

### Requirement: An unrecognized `--only` value refuses cleanly

The system SHALL accept exactly `skills`, `instructions`, or `mcp` as
`--only`'s value and refuse with no writes for any other value, the
same posture `--from`'s own "must be one of" refusal already uses.

#### Scenario: An invalid `--only` value is refused before any work happens
- **WHEN** `trellis migrate --from <agent> --only bogus` runs
- **THEN** the command refuses with a message naming the three valid
  values and performs no writes, without probing the named agent at all

### Requirement: `trellis migrate --from <agent>` imports an existing agent's real MCP servers into canonical source

The system SHALL read the named agent's real, already-configured MCP
servers (claude-code: `~/.claude.json`'s `mcpServers`; kiro:
`~/.kiro/settings/mcp.json`'s `mcpServers`; codex: `codex mcp list
--json` plus `~/.codex/config.toml`'s `[mcp_servers.<name>.env]`
table) and convert each into canonical's `McpServerDef` shape for
comparison and, when new, creation in `~/.trellis/mcp/servers.yaml`.
pi has no static MCP config to read — it is never a migrate-in source
for this category. This requirement's server-reading behavior applies
only when `mcp` is in scope for the run (no `--only`, or `--only mcp`).

#### Scenario: A new MCP server is imported
- **WHEN** the named agent has a real MCP server configured that
  canonical source has no entry for yet
- **THEN** `~/.trellis/mcp/servers.yaml` gains a new entry for that
  server, converted from the agent's own real definition

#### Scenario: pi is never an MCP migration source
- **WHEN** `trellis migrate --from pi` runs with `mcp` in scope
- **THEN** the plan contains no MCP items at all — pi has no static
  MCP config to read from

#### Scenario: `--only skills` or `--only instructions` excludes every MCP server from the plan
- **WHEN** `trellis migrate --from <agent> --only skills` (or
  `--only instructions`) runs
- **THEN** the plan contains no MCP items, and
  `~/.trellis/mcp/servers.yaml` is neither read for comparison nor
  written

### Requirement: MCP server migration never silently overwrites differing content

The system SHALL compare the source agent's real MCP server definition
against any existing canonical entry of the same name before writing.
Identical content is a no-op (already migrated). A server name not yet
in canonical is created. A different definition under the same name is
either a safe reclassification or a conflict:

- **Safe reclassification**: every field outside `env`/`envAliases`/
  `staticEnv` is identical, and the two definitions' env values resolve
  to the exact same literal/reference text per key — only which of
  `env`/`envAliases`/`staticEnv` a value is filed under changed (e.g.
  after a migrate-read classification fix ships). This is applied
  automatically, the same as a create, and reported distinctly from
  both a create and a conflict.
- **Conflict**: anything else — reported, not overwritten.

#### Scenario: Re-running migrate after a successful MCP import is a no-op
- **WHEN** `trellis migrate --from <agent>` runs again after a prior
  successful import of the same MCP server, and the source agent's
  configuration for it hasn't changed
- **THEN** that server is reported as already migrated, and
  `~/.trellis/mcp/servers.yaml` is not modified for it

#### Scenario: An MCP server that already exists in canonical with a different definition is a conflict
- **WHEN** canonical source already has an MCP server of the same name
  whose definition differs from the source agent's real configuration in
  a way that isn't a pure env-classification shuffle (a real value
  change, a different command, an added/removed field)
- **THEN** the command reports a conflict for that server and does not
  overwrite the existing canonical entry

#### Scenario: A stale env-classification entry is safely repaired, not conflicted
- **WHEN** canonical already has an MCP server whose only difference
  from the freshly-read definition is that a value moved between
  `staticEnv` and `env`/`envAliases` while resolving to the exact same
  literal/reference text (e.g. a `staticEnv` entry containing
  `"${SOME_NAME}"` that now correctly reads as an `envAliases`/`env`
  reference to `SOME_NAME`)
- **THEN** the command updates that server's canonical entry to the
  newly-classified definition, reports it as a reclassification (not a
  create, not a conflict), and does not touch any other server

### Requirement: An MCP server Trellis cannot safely represent for that agent is named as unsupported, never guessed

The system SHALL refuse to fabricate a canonical definition for an MCP
server whose real configuration cannot be reliably recovered — today,
specifically a Codex-configured server whose transport is not
`stdio` — reporting it as unsupported rather than silently dropping it
or guessing at fields this codebase has no verified evidence for.

#### Scenario: A non-stdio Codex MCP server is reported as unsupported, not migrated
- **WHEN** `codex mcp list --json` reports an MCP server whose
  transport type is not `stdio`
- **THEN** the plan reports that server as unsupported for MCP
  migrate-in, names the reason, and does not write anything for it to
  `~/.trellis/mcp/servers.yaml`

### Requirement: Migrated MCP servers are not scoped to the source agent

The system SHALL NOT write an `agents:` restriction on a migrated MCP
server limiting it to the source agent — migrated servers are shared
across all present agents by default, the same as any other canonical
MCP server with no explicit scope.

#### Scenario: A migrated MCP server is unscoped
- **WHEN** an MCP server is migrated from Kiro into canonical source
- **THEN** its `servers.yaml` entry has no `agents:` restriction, and
  it is available to every present agent on the next `trellis mcp
  sync`

### Requirement: A `${NAME}` env value is recognized as a reference regardless of whether NAME matches its own key

The system SHALL classify a stdio MCP server's env value as a reference
needing resolution whenever it matches exactly `${NAME}` for any valid
variable name — not only when `NAME` equals the key it's declared
under. A same-name reference (`KEY: "${KEY}"`) SHALL populate `env`
(unscoped, self-referencing) exactly as before this requirement existed;
a differently-named reference (`KEY: "${OTHER_NAME}"`) SHALL populate
`envAliases` (`{ KEY: "OTHER_NAME" }`) instead of being treated as a
literal. A value that is not exactly `${NAME}` — no wrapping braces, or
extra text before/after — remains a literal, unaffected by this
requirement.

#### Scenario: A differently-named reference migrates into envAliases, not staticEnv
- **WHEN** a source agent's real config declares an env entry
  `OPENAPI_MCP_HEADERS: "${NOTION_OPENAPI_MCP_HEADERS}"`
- **THEN** the migrated `McpServerDef` has
  `envAliases: { OPENAPI_MCP_HEADERS: "NOTION_OPENAPI_MCP_HEADERS" }`,
  and no `staticEnv` entry for that key

#### Scenario: A same-name reference still migrates into env, unchanged
- **WHEN** a source agent's real config declares an env entry
  `GITLAB_PERSONAL_ACCESS_TOKEN: "${GITLAB_PERSONAL_ACCESS_TOKEN}"`
- **THEN** the migrated `McpServerDef` has
  `env: ["GITLAB_PERSONAL_ACCESS_TOKEN"]`, exactly as before this
  requirement existed

#### Scenario: A genuinely literal value is still a literal
- **WHEN** a source agent's real config declares an env entry
  `TANKA_ENV: "sd-or"`
- **THEN** the migrated `McpServerDef` has `staticEnv: { TANKA_ENV:
  "sd-or" }`, unaffected by this requirement

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
