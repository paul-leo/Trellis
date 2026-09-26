# Proposal

## Why

The `skills` CLI makes GitHub-hosted Agent Skills easy to discover and add,
but writes its own canonical copy into `.agents/skills` or a user Skill
directory. Those writes bypass Trellis's managed boundary, canonical scope,
backup, and drift checks.

Trellis needs an equally short remote-import command whose only persistent
source is the Trellis canonical store, so users can adopt an external Skill
without giving up managed delivery.

## What Changes

- Add a top-level `trellis add <GitHub source> --skill <name>` command that
  accepts GitHub `owner/repo` shorthand or HTTPS repository URLs.
- Discover a named, case-correct `SKILL.md` in the fetched source, import its
  complete directory into `~/.trellis/skills/`, and immediately sync it only
  to Trellis-managed Agents.
- Support `--agent` as a scope selector for managed Agent ids and `--agent
  '*'` for the current managed set; preserve the unscoped all-managed default.
- Record source URL, requested ref, resolved immutable commit, source
  subdirectory, and content digest in `~/.trellis/skills.lock.json`.
- Add `trellis update [skills...]` for tracked remote Skills, with a plan that
  refuses to replace a locally modified canonical Skill.
- Support `--list`, `--dry-run`, `--json`, `--branch`, `--yes`, and `--global`
  compatibility aliases where their Trellis meaning is unambiguous. Reject
  project-scoped or copy-mode behavior that would create a second source of
  truth.
- Fetch only into a temporary directory, never execute downloaded files, and
  retain the existing user confirmation and backup/rollback discipline.

## Capabilities

### New Capabilities

- `remote-skill-import`: GitHub Skill discovery, canonical import, provenance
  locking, and update planning for Trellis-managed delivery.

### Modified Capabilities

- `canonical-content-management`: expose remote Skill add and update through
  the canonical Skill command surface.
- `backup-and-rollback`: include remote Skill provenance and canonical
  directory replacement in one reversible backup session.
- `agent-management-scope`: restrict remote Skill target selectors to the
  existing managed boundary.
- `cli-standard-options`: give remote Skill commands consistent dry-run and
  JSON behavior.

## Impact

- New remote-source, provenance-lock, and update-planning modules; extensions
  to CLI dispatch, Skill CRUD, backup, docs, and tests.
- Uses GitHub's public Git transport and a locally available `git` executable;
  no new package dependency and no downloaded code execution.
- `~/.trellis/skills.lock.json` becomes Trellis-owned bookkeeping. Existing
  local `trellis skill add --from` users keep their current behavior.
