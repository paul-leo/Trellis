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
Identical content is a no-op (already migrated). A different
definition under the same name is a conflict: reported, not
overwritten. A server name not yet in canonical is created.

#### Scenario: Re-running migrate after a successful MCP import is a no-op
- **WHEN** `trellis migrate --from <agent>` runs again after a prior
  successful import of the same MCP server, and the source agent's
  configuration for it hasn't changed
- **THEN** that server is reported as already migrated, and
  `~/.trellis/mcp/servers.yaml` is not modified for it

#### Scenario: An MCP server that already exists in canonical with a different definition is a conflict
- **WHEN** canonical source already has an MCP server of the same name
  whose definition differs from the source agent's real configuration
- **THEN** the command reports a conflict for that server and does not
  overwrite the existing canonical entry

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

