## ADDED Requirements

### Requirement: `trellis init` creates a minimal valid canonical source if one doesn't exist

The system SHALL provide a `trellis init` command that creates
`~/.trellis/` and a minimal, valid skeleton inside it — `agents.md`,
`mcp/servers.yaml` (empty `servers` and `known_host_injected`),
`secrets.policy.yaml` (empty `allowed_vars`, a seeded generic
`reject_patterns` list) — sufficient for `trellis sync`/`mcp sync`/
`secrets audit` to run without refusing for lack of a canonical source.
It SHALL NOT create `scope.yaml` — that file's absence already means
"everything shared," and generating an empty stub would misleadingly
suggest scoping is required setup.

#### Scenario: A fresh machine with no canonical source gets a working one
- **WHEN** `trellis init` runs and `~/.trellis/` does not exist
- **THEN** `~/.trellis/agents.md`, `~/.trellis/mcp/servers.yaml`, and
  `~/.trellis/secrets.policy.yaml` all exist afterward, and
  `trellis doctor`/`trellis sync`/`trellis mcp sync`/`trellis secrets
  audit` all run without a "no canonical source" refusal

#### Scenario: scope.yaml is never generated
- **WHEN** `trellis init` runs, fresh or already-initialized
- **THEN** `~/.trellis/scope.yaml` does not exist afterward unless the
  user creates it themselves

### Requirement: `trellis init` is idempotent and additive-only, per file

The system SHALL NOT overwrite any existing file when re-running
`trellis init` against an already-initialized (fully or partially)
`~/.trellis/`. Each of `agents.md`, `mcp/servers.yaml`,
`secrets.policy.yaml` is checked independently: present → left
untouched and reported as already there; absent → created from the
template.

#### Scenario: A fully initialized source is a no-op
- **WHEN** `trellis init` runs and all three generated files already
  exist
- **THEN** none of them are modified, and the command reports that
  initialization was already complete

#### Scenario: A partially initialized source only fills the gaps
- **WHEN** `trellis init` runs and `agents.md` exists (e.g.
  hand-authored) but `mcp/servers.yaml` does not
- **THEN** `agents.md`'s existing content is untouched, and
  `mcp/servers.yaml` is created from the template

### Requirement: `trellis init` reports which agents are present and points at migration

After ensuring the skeleton exists, `trellis init` SHALL probe all four
agents (the same probes `doctor` uses) and print, for each present
agent, a pointer toward importing its real capabilities — without
performing any extraction itself.

#### Scenario: A present agent gets a next-step pointer
- **WHEN** `trellis init` runs and Claude Code is present on the
  machine
- **THEN** the output includes a line naming Claude Code and pointing
  at the command (or documentation) for importing its existing
  skills/instructions
