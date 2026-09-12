## Context

Every input this command needs already exists and is already tested:
`AgentSnapshot` (probed by each agent's own `probe()`, unchanged) gives
skill `name`/`dir`/`realDir`/`isSymlink`/`caseCorrect` and an
`instructionsFile` with the same `isSymlink` distinction. No new
discovery logic — `migrate` is a consumer of data `doctor` already
produces, wired to a new destination (canonical source) instead of a
`Finding`.

`init`'s generated `agents.md` is a fixed, known string
(`AGENTS_MD_TEMPLATE` in `src/commands/init.ts`). Detecting "canonical
agents.md is still just the placeholder, safe to replace" only works
reliably by importing that exact constant and comparing byte-for-byte —
retyping an equivalent-looking string in `migrate.ts` would silently
drift the moment either file changes.

## Goals / Non-Goals

**Goals**
- Importing an existing agent's real skills/instructions into canonical
  source requires no manual file copying — the exact gap this session's
  own pi pilot exposed by having to do it entirely by hand.
- Never silently overwrite real content — a skill or instructions file
  already in canonical with *different* content from the source agent
  is a conflict, reported and left alone, the same posture every
  adapter's `plan()`/`apply()` already takes.
- Idempotent: re-running `migrate --from X` after a successful run (or
  after `sync` has since symlinked things back out) reports "already
  migrated" for identical content, not a spurious conflict.

**Non-Goals**
- No MCP server extraction (proposal.md) — different config formats,
  different risk profile, deliberately deferred.
- No merge/diff UI for a conflicting instructions file — text merging
  well is a much larger problem than this command needs to solve to be
  useful; a human resolving a reported conflict by hand is enough.

## Decisions

### D1 — Skip symlinked skills and case-broken skills, matching the manual pi pilot's own judgment calls

A skill entry with `isSymlink: true` is shared in from elsewhere (e.g.
Codex's `~/.agents/skills` convention) — copying it would duplicate
content that already has a canonical-adjacent home, not migrate
something owned by this agent. A skill with `caseCorrect: false` is
already known (via `agent-state-probing`'s own case-mismatch detection)
to be undiscoverable on at least one other agent — migrating it forward
would carry the defect into canonical source instead of surfacing it.
Both are reported in the command's output (skipped-with-reason, not
silently dropped) so the user knows why a skill they expected to see
didn't get migrated.

### D2 — Content-identity conflict detection: byte comparison, not a heuristic

"Already migrated, safe to skip" vs. "different content, a real
conflict" is decided by reading both directories' files and comparing
bytes — not by name matching alone, not by mtime, not by a hash-based
shortcut that could theoretically collide. Directory comparison: same
set of relative file paths, and each file's content byte-identical.
Anything else (a missing file, an extra file, one differing byte) is a
conflict.

### D3 — Instructions conflict detection: byte-compare against `init`'s own template

`migrate` imports `AGENTS_MD_TEMPLATE` directly from
`src/commands/init.ts` (a value import, not a duplicated string) and
treats canonical `agents.md`'s current content as "still the
placeholder" only when it matches that constant exactly. Any other
existing content — including a previous `migrate --from` run's
output — is a real conflict requiring a human decision about which
agent's instructions should win.

### D4 — No scope.yaml write, unlike the manual pi pilot

The manual pi pilot wrote `scope.yaml` entries restricting every
migrated skill to `[pi]` — appropriate there because that was
explicitly a one-directional trial ("give pi these capabilities, touch
nothing else"). `migrate`'s stated purpose is the opposite: take an
agent's existing capabilities and make them the shared baseline other
agents can also `sync` from. Scoping migrated content back down to only
the source agent would silently defeat that purpose for every future
`sync` run. A user who specifically wants pilot-style restriction can
still hand-edit `scope.yaml` after migrating — this command just
doesn't do it automatically.

### D5 — `--dry-run` reuses the same plan-then-apply shape every adapter already has

`collectMigratePlan(agent, canonical, snapshot)` returns a list of
`{ kind: "skill" | "instructions", name, action: "create" | "skip-symlink" |
"skip-case-broken" | "already-migrated" | "conflict", detail }` — pure,
no I/O — and `applyMigratePlan(plan)` performs the actual file writes.
`--dry-run` calls the former and prints it without calling the latter.
Same separation `AdapterPlanItem`/`plan()`/`apply()` already established
for every other command; not a new pattern.

## Risks / Trade-offs

- Byte-for-byte directory comparison is O(total file size) per skill,
  every `migrate` invocation. Skills are small text files
  (`SKILL.md` + occasional small assets) — not a real cost at today's
  scale; revisit only if a skill directory grows large enough for this
  to matter.
- Skipping case-broken skills means a user has to fix the case problem
  on the source agent *first*, then migrate, rather than migrate fixing
  it for them. Deliberate: `migrate` copies content, it doesn't repair
  it — silently renaming a file during migration would be a surprising
  side effect for a command whose job is "bring this in as-is."

## Migration Plan

Purely additive — a new command touching no existing adapter, no
existing schema field, no existing command's behavior.

## Open Questions

None outstanding.
