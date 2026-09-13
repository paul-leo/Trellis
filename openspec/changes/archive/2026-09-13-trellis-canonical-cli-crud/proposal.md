## Why

Neither canonical skills nor canonical MCP servers have any command-line
add/remove/list surface today — `src/cli.ts`'s `mcp` command recognizes
exactly one subcommand, `sync`, and there is no `skill` command at all.
Both categories are fully usable already (sync/mcp sync don't care how
a canonical entry got there), just only via hand-editing files
directly: `~/.trellis/skills/<name>/SKILL.md` for skills,
`~/.trellis/mcp/servers.yaml`'s raw YAML for MCP servers. This is
roadmap.md's P12: the second of five real gaps found while dogfooding
this project's own real-machine migration story — a user who wants to
manage canonical content without waiting on `migrate` (or in addition
to it) has to reach for a text editor every time.

## What Changes

- New `trellis skill list` — lists every skill in `~/.trellis/skills/`
  with its resolved scope (which managed agents it reaches).
- New `trellis skill add <name> --from <path>` — copies a real skill
  directory into canonical, same conflict/already-present detection
  `migrate`'s own skill-planning logic already uses.
- New `trellis skill remove <name>` — deletes a skill from canonical.
  Confirmed by reading `src/adapters/symlinkPlan.ts` before writing this:
  skills already have an ownership marker (a symlink whose target
  resolves inside canonical root), so removing one from canonical is
  *already* enough — the next `trellis sync` on any managed agent
  auto-detects and removes the now-stale symlink. No new removal-
  propagation code is needed for skills; this is real, existing
  behavior, not something this change has to build.
- New `trellis mcp list` — lists every server in `servers.yaml` with
  its transport, `enabled`/`agents` scope, and whether it references
  `env`/`static_env` — names and shapes only, never a resolved secret
  value.
- New `trellis mcp add <name> ...` — writes a new `McpServerDef` entry
  into `servers.yaml` (stdio and http/sse variants). This is the first
  code path that writes `servers.yaml` at all — today only
  `loadServersYaml` (read) exists; `init.ts`'s scaffold write is a
  literal template string, not a round-trip writer.
- New `trellis mcp remove <name>` — removes an entry from
  `servers.yaml` only. Does **not** touch any agent's already-synced
  native config — that gap (`mcp sync` has no automatic removal, unlike
  skills) is roadmap.md P14's job, explicitly out of scope here.
- `--dry-run`/`--json` support on every new subcommand, consistent with
  every existing command.

## Capabilities

### New Capabilities

- `canonical-content-management`: command-line create/list/remove for
  canonical skills and MCP server definitions — authoring canonical
  source directly, as an alternative to hand-editing files or running
  `migrate`.

### Modified Capabilities

(none — this is purely additive; `mcp-server-sync` and
`skill-instructions-sync` govern canonical→agent distribution, which
this change does not touch)

## Impact

- `src/cli.ts` — new `skill` command; `mcp` command gains `add`/
  `remove`/`list` alongside its existing `sync`.
- `src/commands/skill.ts` (new) — list/add/remove plan+apply, mirroring
  `migrate.ts`'s existing skill-comparison logic rather than
  reimplementing it.
- `src/commands/mcp.ts` — gains list/add/remove alongside its existing
  sync logic.
- `src/core/canonical.ts` — gains a `servers.yaml` writer (the inverse
  of `fromServerDefYaml`), using the `yaml` package's `Document`-based
  edit API to preserve existing comments/formatting for untouched parts
  of the file — no new dependency, and matches the project's existing
  "surgical edit, don't clobber hand-authored content" precedent
  (`src/lib/tomlSection.ts`'s equivalent for Codex's TOML).
- No change to `src/sdk.ts` — this reads/writes the *existing*
  `McpServerDef`/`SkillRef` shapes, no new canonical-schema fields.
