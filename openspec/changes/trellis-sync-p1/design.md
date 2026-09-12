## Context

P0 (`trellis doctor`, archived as `2026-09-12-trellis-doctor-p0`) proved
the four agents' state is reliably readable and gave P1 four working
`AgentSnapshot` probes to reuse for `verify()`. Nothing in the repo writes
anything yet. `docs/architecture.md` and `docs/implementation-plan.md`
already specify most of this phase's shape (symlink adapters, scope
filtering, create/repair/remove/refuse); this document exists to pin the
decisions those left open before code is written, and to record the pi
adapter-notes correction made while starting this change (see proposal.md).

Stakeholder: single developer (project owner), same as P0 — first real
user, no external consumers.

## Goals / Non-Goals

**Goals:**
- Make "add a skill once, it reaches every agent" true for skills and
  instructions, for all four agents.
- Reuse P0's probes for `verify()` rather than re-implementing state
  reading a second time.
- Every write is safe to re-run (idempotent) and safe against a machine
  that already has real, non-Trellis content in an agent's skill
  directory (refuse, don't overwrite).

**Non-Goals:**
- MCP sync (P2) and pi's MCP bridge (P4) — this change touches skills and
  the instructions file only.
- Workspace/project-local `.trellis/` (see `docs/architecture.md` "Global
  vs. workspace scope") — global `~/.trellis` only.
- A `trellis unsync` / rollback command — see Migration Plan for how
  removal actually works without one.
- Changing `agent-state-probing` or `capability-drift-detection`'s
  requirements — `verify()` calls those probes exactly as P0 built them.

## Decisions

### D1 — YAML parsing: use a library, don't hand-roll

`scope.yaml` is genuinely nested (agent lists under skill/agent/memory
names), unlike P0's Codex `instructions = "..."` extraction, which was a
single top-level string field a regex could safely grab. Use the `yaml`
npm package (actively maintained, zero further dependencies, pure JS) to
parse it. This is read-only — Trellis never writes `.trellis/scope.yaml`
back (the user authors it directly, same as every other canonical source
file), so none of Codex's TOML round-trip-fidelity concerns (P2) apply
here; any compliant YAML parser is sufficient, `yaml` is just a
well-established default.

**Alternative considered**: `js-yaml`. Also fine; `yaml` was picked for
having a smaller dependency footprint and native TypeScript types, not for
any capability difference that matters here.

### D2 — Skill distribution is whole-directory symlinks, never per-file

`~/.trellis/skills/<name>/` is symlinked in its entirety as
`<agent-skill-root>/<name>` → `~/.trellis/skills/<name>`. This was already
the working assumption throughout `docs/architecture.md` and is what P0's
`isSymlinkTo`/`realpathDedupe` already assume (a skill's identity is "is
this directory a symlink," not "are these individual files symlinks") —
P1 is where it actually gets implemented, not where it's decided.

### D3 — Instructions file target per agent, pi included

Each adapter symlinks the single canonical `~/.trellis/agents.md` to:
- Claude Code: `~/.claude/CLAUDE.md`
- Codex: wherever `~/.codex/config.toml`'s `instructions` key points
  (already read in P0 via the same heuristic regex; P1 does not change
  that key, only symlinks the file it names — see Risks for what happens
  if that key is unset)
- Kiro: `~/.kiro/steering/CLAUDE.md`
- pi: `~/.pi/agent/AGENTS.md` — specifically `AGENTS.md`, not
  `AGENTS.override.md`. Pi checks `AGENTS.override.md` first (design.md D5
  in the archived P0 change); using that name would make Trellis's own
  managed file describe itself as an override of something else, which is
  backwards — Trellis's file *is* the baseline. See Risks for what happens
  if a real `AGENTS.override.md` already exists there from something else.

### D4 — Instructions file follows the exact same create/repair/remove/refuse
rules as skills

No special case: a real (non-symlink) file already at the target path is a
refuse-and-surface-conflict, identical to a skill directory. This was
already implied by `src/core/adapter.ts`'s existing contract (extended in
a prior change) — stated explicitly here so it isn't accidentally
special-cased per-agent during implementation.

### D5 — A bad `scope.yaml` reference is a load-time warning, not a hard failure

If `scope.yaml` names a skill/agent/memory that doesn't exist in
canonical (typo, stale entry after a rename), `loadCanonicalSource()`
records a diagnostic and proceeds treating that entry as if unscoped-but-
nonexistent (i.e., it produces no plan item for anything, since there's no
matching skill to scope) rather than throwing and blocking every other,
valid skill from syncing. Mirrors P0's own "surface a diagnostic, don't
silently swallow, don't let one bad input block everything else" pattern
(`docs/research.md`'s D2 risk mitigation).

## Risks / Trade-offs

- **[Risk]** Codex's `instructions` key in `config.toml` might be unset
  entirely (P0's heuristic already handles a missing key by returning
  `undefined`). **Mitigation**: if unset, the Codex adapter's instructions
  sync is a no-op for that agent with a diagnostic, not a crash or a
  silent write to a guessed path — Trellis does not decide a value for a
  Codex-owned setting it doesn't parse structurally.
- **[Risk]** A real `~/.pi/agent/AGENTS.override.md` already existing
  (from something unrelated to Trellis) would shadow Trellis's managed
  `AGENTS.md` — pi would read the override, never Trellis's file, with no
  error surfaced anywhere. **Mitigation**: out of scope for this change to
  fully solve (would need `doctor` to check for a shadowing override file,
  a `capability-drift-detection` change, not a P1 sync concern) — noted
  here so it isn't mistaken for an oversight if it comes up later, and
  flagged as a candidate follow-up for `capability-drift-detection`.
- **[Trade-off]** No `trellis unsync` command. Accepted because removal is
  already fully expressible without one: delete a skill (or its
  `scope.yaml` entry) from canonical, re-run `trellis sync skills`, and
  `apply()`'s "remove" case (D2/D4 in `src/core/adapter.ts`, already
  documented) cleans up the corresponding symlink on every agent it was on.
  Deleting all of `~/.trellis/skills/*` and re-running removes every
  Trellis-managed symlink this way too — a full "undo" falls out of the
  existing create/remove contract rather than needing a second command.

## Migration Plan

No migration — first version of this capability, nothing to migrate from.
Rollback if a bug ships: the trade-off above doubles as the rollback
mechanism (remove the offending canonical entries, re-run sync, the
corresponding symlinks are removed by the same `apply()` that created
them). Nothing in this change touches any file Trellis doesn't itself
manage (D4's refuse rule is exactly what guarantees that).

## Open Questions

None blocking. The `AGENTS.override.md` shadowing risk (above) is a real,
open follow-up but doesn't block shipping this change — it's a detection
gap for a later `capability-drift-detection` change, not a P1 defect.
