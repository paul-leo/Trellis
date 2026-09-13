## ADDED Requirements

### Requirement: `trellis skill list` shows every canonical skill with its resolved scope

The system SHALL list every skill directory under `~/.trellis/skills/`
and, for each, print its resolved scope — the managed agents it
reaches, computed the same way `sync` already does (`resolveScope`
against `managedAgents`), never a raw, unresolved `scope.yaml` entry.

#### Scenario: An unscoped skill resolves to the full managed set
- **WHEN** `trellis skill list` runs and a skill has no `scope.yaml`
  entry
- **THEN** its listed scope is exactly the current managed set, not
  "all four agents" unconditionally

#### Scenario: A skill scoped to agents outside the managed set resolves to the intersection
- **WHEN** a skill's `scope.yaml` entry names an agent not currently in
  `managedAgents`
- **THEN** its listed scope excludes that agent, matching what `sync`
  itself would actually reach

### Requirement: `trellis skill add <name> --from <path>` imports a real skill directory into canonical

The system SHALL copy `<path>`'s content into
`~/.trellis/skills/<name>/` when `<path>` contains a case-correct
`SKILL.md` and canonical has no directory of that name yet. It SHALL
refuse, with no writes, when `<path>` has no `SKILL.md` or has one only
under the wrong case (`skill.md`).

#### Scenario: A valid source directory is copied in
- **WHEN** `trellis skill add my-skill --from /path/to/dir` runs and
  that directory contains `SKILL.md` and canonical has no `my-skill`
  yet
- **THEN** `~/.trellis/skills/my-skill/` is created with that
  directory's real content

#### Scenario: A source directory without SKILL.md refuses
- **WHEN** the given `--from` directory has no `SKILL.md` at all
- **THEN** the command refuses with a clear message and creates nothing

#### Scenario: A source directory with wrong-case skill.md refuses
- **WHEN** the given `--from` directory has `skill.md` but not
  `SKILL.md`
- **THEN** the command refuses, naming the case problem, and creates
  nothing

### Requirement: `trellis skill add` never silently overwrites an existing canonical skill

The system SHALL compare `<path>`'s content against
`~/.trellis/skills/<name>/` (if it already exists) before writing,
using the same byte-for-byte comparison `migrate` already uses.
Identical content is a no-op. Different content is a conflict: reported,
not overwritten. There is no override flag — resolving a conflict is
always a manual decision, the same posture every other conflict in
this project already has.

#### Scenario: Re-adding identical content is a no-op
- **WHEN** `trellis skill add my-skill --from /path/to/dir` runs again
  and canonical's `my-skill` is already byte-identical to that
  directory
- **THEN** the command reports "already present" and writes nothing

#### Scenario: Adding over a canonical skill with different content is a conflict
- **WHEN** canonical already has a `my-skill` whose content differs
  from the given `--from` directory
- **THEN** the command reports a conflict and does not overwrite the
  existing canonical content

### Requirement: `trellis skill remove <name>` deletes a skill from canonical, letting sync's own removal detection un-sync it everywhere

The system SHALL delete `~/.trellis/skills/<name>/` from canonical when
`trellis skill remove <name>` runs against an existing skill, and
refuse cleanly when no such skill exists. This requirement performs no
new removal-propagation logic on any agent's native config — every
managed agent's own stale symlink (a symlink whose stored target
resolved inside canonical root, now gone) is already detected and
removed by `sync`'s own existing logic on its next run.

#### Scenario: Removing an existing skill deletes its canonical directory
- **WHEN** `trellis skill remove my-skill` runs and
  `~/.trellis/skills/my-skill/` exists
- **THEN** that directory is deleted, and no other canonical content is
  touched

#### Scenario: Removing a non-existent skill refuses cleanly
- **WHEN** `trellis skill remove not-a-real-skill` runs
- **THEN** the command refuses with a clear message and deletes nothing

#### Scenario: A subsequent sync un-syncs the removed skill from every managed agent
- **WHEN** a skill was removed from canonical and `trellis sync` runs
  afterward against an agent that previously had it symlinked in
- **THEN** that agent's now-stale symlink (pointing at the deleted
  canonical directory) is removed, using `sync`'s pre-existing
  ownership-marker detection, not new logic this requirement adds

### Requirement: `trellis mcp list` shows every canonical MCP server definition without ever printing a resolved secret value

The system SHALL list every server entry in `~/.trellis/mcp/servers.yaml`
with its transport, `enabled` state, agent scope, and env
references — `env`'s entries as bare variable names, never resolved
against `process.env` or `secrets.policy.yaml`'s `env_file`.
`static_env`'s values SHALL be printed in full, since they are
non-secret by `McpServerDef`'s own contract.

#### Scenario: An env-referencing server lists names, never values
- **WHEN** a server declares `env: [GITLAB_PERSONAL_ACCESS_TOKEN]`
- **THEN** `trellis mcp list`'s output shows that name and never reads
  or prints any real environment variable value

#### Scenario: A static_env server's non-secret values are shown
- **WHEN** a server declares `static_env: { TANKA_ENV: "sd-or" }`
- **THEN** `trellis mcp list`'s output shows `TANKA_ENV: sd-or` in full

#### Scenario: A disabled server is listed, marked as disabled
- **WHEN** a server has `enabled: false`
- **THEN** it still appears in the listing, clearly marked disabled —
  not hidden, since canonical still defines it

### Requirement: `trellis mcp add <name>` writes a new server definition into canonical

The system SHALL write a new `McpServerDef` entry into
`~/.trellis/mcp/servers.yaml` for a stdio server (`--transport stdio
--command <cmd>` plus optional `--args`/`--env`/`--static-env`/
`--agents`/`--enabled`) or an http/sse server (`--transport http|sse
--url <url>` plus optional `--headers`/`--agents`/`--enabled`), using an
edit that preserves the rest of the file's existing content and
comments untouched.

#### Scenario: A new stdio server is added and preserved formatting elsewhere
- **WHEN** `trellis mcp add my-server --transport stdio --command npx
  --args -y,my-mcp-server` runs against a `servers.yaml` that already
  has hand-authored comments elsewhere in the file
- **THEN** the new `my-server` entry appears in `servers.yaml`, and
  every pre-existing comment and entry in the file is byte-for-byte
  unchanged

#### Scenario: A new http server with static_env is added
- **WHEN** `trellis mcp add my-remote --transport http --url
  https://example.com/mcp --static-env ENV=prod` runs
- **THEN** `servers.yaml` gains a `my-remote` entry with `transport:
  http`, `url`, and `static_env: { ENV: prod }`

### Requirement: `trellis mcp add` never silently overwrites an existing canonical server

The system SHALL refuse, with no write, when `<name>` already exists in
`servers.yaml` — there is no override flag; resolving a name collision
is always `trellis mcp remove` followed by a fresh `add`, or a direct
hand-edit.

#### Scenario: Adding over an existing server name refuses
- **WHEN** `trellis mcp add my-server ...` runs and `servers.yaml`
  already has a `my-server` entry
- **THEN** the command refuses with a clear message and the existing
  entry is unchanged

### Requirement: `trellis mcp remove <name>` removes a server definition from canonical only

The system SHALL delete `<name>`'s entry from `~/.trellis/mcp/servers.yaml`
when it exists, and refuse cleanly when it doesn't. This requirement
SHALL NOT modify any agent's native MCP configuration — a server
already synced to an agent stays exactly as it is until that agent's
own configuration is edited by hand or by a future capability that adds
sync-side removal (roadmap.md P14, not this requirement).

#### Scenario: Removing an existing server deletes its canonical entry only
- **WHEN** `trellis mcp remove my-server` runs and `servers.yaml` has a
  `my-server` entry
- **THEN** that entry is deleted from `servers.yaml`, and no agent's
  native MCP configuration is touched, even if that agent already has
  `my-server` configured from an earlier `mcp sync`

#### Scenario: Removing a non-existent server refuses cleanly
- **WHEN** `trellis mcp remove not-a-real-server` runs
- **THEN** the command refuses with a clear message and deletes nothing

### Requirement: `--dry-run` previews any canonical CRUD write with zero writes

The system SHALL support `--dry-run` on `skill add`, `skill remove`,
`mcp add`, and `mcp remove`, computing and printing the same plan the
real run would produce without creating, modifying, or deleting any
file.

#### Scenario: Dry-run skill add computes the plan with zero writes
- **WHEN** `trellis skill add my-skill --from /path/to/dir --dry-run`
  runs
- **THEN** the output names the planned action and no file under
  `~/.trellis/skills/` is created, modified, or deleted

#### Scenario: Dry-run mcp remove computes the plan with zero writes
- **WHEN** `trellis mcp remove my-server --dry-run` runs
- **THEN** the output states the entry would be removed, and
  `servers.yaml` is not modified
