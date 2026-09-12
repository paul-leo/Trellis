# trellis-cli-migrate

## Why

`trellis init` (previous change) turns "no canonical source" into an
empty, working one — but empty is still empty. The actual onboarding
scenario this project exists for — "I already use Claude Code, I want
Trellis to take over" — has exactly one implementation so far: this
session's own manual pi pilot (`mkdir`, hand-copy 44 skill directories
one by one, hand-write `scope.yaml`, hand-write `agents.md` from
`CLAUDE.md`'s content). `init`'s own generated `agents.md` template
already names this command (`trellis migrate --from <agent>`) as the
next step for a present agent — it doesn't exist yet.

Every fact this design needs is already available without new
discovery work: `AgentSnapshot` (from each agent's existing `probe()`)
already carries exactly what's needed per skill — `name`, `dir`,
`realDir`, `isSymlink`, `caseCorrect` — and `instructionsFile` with the
same `isSymlink` distinction. This session's own manual pi migration
already established the two judgment calls that matter here: skip a
skill that's already a symlink (it's shared-in from elsewhere, not this
agent's own content — copying it would duplicate, not migrate,
content), and skip a skill `doctor` already knows is
case-broken/undiscoverable on at least one other agent (migrating a
known-broken skill just relocates the problem).

## What Changes

- New command: `trellis migrate --from <claude-code|codex|kiro|pi>`.
- Reads the named agent's real, current `AgentSnapshot` (its existing
  `probe()` — no new discovery logic). Refuses immediately if that
  agent isn't present on this machine.
- For each of that agent's skills:
  - Skip if `isSymlink` (shared-in content, not this agent's own).
  - Skip if `!caseCorrect` (already known-broken; report why, don't
    silently drop it without a trace).
  - If canonical `skills/<name>/` doesn't exist yet: copy the skill
    directory's real content in.
  - If it already exists: compare content. Identical → report
    "already migrated," untouched (idempotent, re-running `migrate` is
    always safe). Different → report a conflict, refuse to overwrite
    (the same never-silently-clobber discipline every adapter's own
    `plan()`/`apply()` already follows) — a real judgment call (which
    agent's version wins) that a human, not this command, should make.
- For instructions: if the agent's `instructionsFile` exists and isn't
  itself a symlink, read its content.
  - If canonical `agents.md` doesn't exist, or exists with exactly
    `init`'s own placeholder content (byte-for-byte, imported from
    `init.ts` rather than duplicated): write the agent's real content
    in.
  - Otherwise (real, different content already there): report a
    conflict, refuse to overwrite — same reasoning as skills.
- No `scope.yaml` writes. Migrated content defaults to shared across
  all four present agents — deliberately different from this session's
  own manual pi pilot, which scoped everything to `[pi]` defensively
  because that was a one-directional "give pi a trial capability set,
  touch nothing else" pilot. `migrate`'s actual purpose is "make an
  existing agent's capabilities the shared baseline" — scoping it back
  down to one agent would defeat that. A user who wants the old
  pilot-style restriction can still hand-edit `scope.yaml` afterward.
- `--dry-run`: prints the plan (what would be created/skipped/
  conflicted) without writing anything — migration is a real,
  potentially large write; previewing it first matches this project's
  existing plan()/apply() separation in every adapter.

## Capabilities Touched

- **NEW**: `canonical-source-migration`.

## Non-Goals

- No MCP server extraction from an existing agent's native config
  (Claude Code's `.claude.json`, Codex's `config.toml`, etc.) — that
  config format is agent-specific and a server definition there may
  hold assumptions (raw env var names, transport-specific fields) that
  don't map cleanly to canonical `mcp/servers.yaml` without a human
  eyeballing each one. Left as a stated limitation, not solved by
  guessing.
- No subagent extraction, even though `AgentSnapshot.subagentsDir`
  exists — only Claude Code has a native concept of a persisted,
  named subagent today (`docs/architecture.md`); nothing to migrate
  *to* symmetrically for the other three agents yet.
- No interactive conflict resolution (choosing which version wins,
  merging two instructions files). A conflict is reported and left for
  the user to resolve by hand — same posture `sync`/`mcp sync` already
  take for their own conflicts.
- No automatic `trellis sync` after migrating — populating canonical
  source and distributing it to agents remain two separate, explicit
  steps, matching how `init` and `sync` are already separate commands.
