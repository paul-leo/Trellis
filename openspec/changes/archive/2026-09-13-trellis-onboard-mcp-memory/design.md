## Context

`onboard.ts`'s own chain docstring names four post-selection steps:
`migrate → sync → mcp sync → secrets audit`. It was written before P16
(`migrate --only mcp`) and P15 (`trellis memory sync`) existed, and was
never revisited after either landed. Confirmed live on this machine:
`resolveMigrateCategories`'s picker hardcodes `["skills", "instructions"]`
(`onboard.ts:258-259`), `OnboardAgentSummary` has no MCP-content field at
all, and nothing in `collectOnboardPlan` ever calls
`collectMemorySyncResult`/`applyMemorySync` from `memory.ts`.

## Goals / Non-Goals

**Goals:**
- `onboard`'s migrate-category selection becomes a genuine three-way
  choice (skills, instructions, mcp), generalized — not a bolted-on
  special case for a third option.
- `onboard`'s chain gains a memory-sync stage as its new final step
  (after mcp sync, before secrets audit), using memory.ts's existing
  logic unchanged.
- An agent whose *only* real content is MCP servers (no skills, no
  custom instructions) becomes a valid migration-source candidate —
  currently impossible, since `hasContent` never looks at MCP at all.

**Non-Goals:**
- No change to `migrate.ts`, `mcp.ts`, or `memory.ts`'s own CLI command
  behavior, flags, or output format for their standalone invocations.
- No new adapter, no new probe, no new dependency.
- No change to `secrets audit`'s own scanning logic.

## Decisions

**D1 — Reuse `collectMigratePlan(agent, homeDir, ["mcp"])` to measure MCP
content, not a new reader call.** `migrate.ts`'s `MCP_READERS` map is
module-private; re-deriving "does this agent have MCP content" by
exporting it (or duplicating its per-agent dispatch) would create a
second place that has to stay in sync with which agents have a reader.
Calling the already-exported `collectMigratePlan` with `only: ["mcp"]`
and counting `plan.items.length` gives the exact same number the actual
migrate step will act on (including pi's correct 0, since pi has no
entry in `MCP_READERS` and the `if (wants("mcp"))` branch's `if (reader)`
guard silently produces zero items for it) — one calculation, always
consistent with what `migrate` itself will do. Cost: on the summary
step, `collectOnboardSummary` becomes async in one more way (already is)
and does one extra migrate-plan computation per present agent; no
network calls involved (readers are local file/subprocess reads
already happening during the real migrate step regardless), so this
duplicates local work but not risk.

**D2 — `resolveMigrateCategories` builds its option list dynamically
from whichever kinds have real content, not a fixed 2-or-3 branch.**
Replace the fixed `wantsSkills`/`wantsInstructions` two-slot structure
with an ordered list of `{ kind: MigrateKind; label: string }` filtered
to only the kinds with real content (skill count > 0, real instructions,
mcp count > 0, in that display order — matching the proposal's own
skill/instructions/mcp ordering). The picker (and its `--json`
silent-default) is shown only when this list has 2 or 3 entries;
1 entry auto-includes with no prompt (unchanged posture from today's
two-kind version); 0 entries cannot occur here since `source` is only
ever resolved from `sourceCandidates` (which requires `hasContent`).
This keeps `MigrateOnlyValue`/`toMigrateKinds`-style enumeration out of
`onboard.ts` entirely — it only ever deals in the `MigrateKind` values
that already exist.

**D3 — Extract `printMemorySyncResult` from `runMemorySync`'s inline
printing, exported alongside `collectMemorySyncResult`/
`applyMemorySync`.** `sync`/`mcp sync`/`secrets audit` each already
export a `collect...Report` + `print...Report` pair that `onboard.ts`
reuses verbatim; `memory.ts` is the one command that bundles collect,
apply, and print into a single `runMemorySync` with no separably
reusable print function. This is a pure extract-function refactor —
`runMemorySync`'s own behavior, flags, and printed output are
byte-for-byte unchanged (verified by keeping its existing test
assertions passing) — done so `onboard.ts` can print the exact same
format without a second, drifting copy of it.

**D4 — Memory sync runs once per onboard invocation, independent of
`managedAgents`.** Unlike sync/mcp-sync (which loop per managed agent),
`collectMemorySyncResult` takes only `homeDir` — there is one shared
memory server, not a per-agent one (memory-content-sync's existing
design). The new stage runs unconditionally once `managedAgents` is
resolved, `dryRun` gating it exactly like every other stage
(`applyMemorySync` only called when `!opts.dryRun`, mirroring
`runMemorySync`'s own dry-run gate).

**D5 — `MemorySyncResult.configured === false` is reported, not
swallowed, and does not by itself make onboard exit non-zero.** This
mirrors `runMemorySync`'s own existing exit-code rule exactly
(`hasConflict = result.configured && result.plan.items.some(i => i.action
=== "conflict")` — an unconfigured memory server is a legitimate "the
user hasn't set this up yet" state, the same posture `mcp sync` already
has for "nothing new to write"). `onboard`'s own overall exit-code
calculation (`runOnboard`'s `hasConflict`) folds in only the conflict
case, the same way it already folds in the other three stages' reports.

## Risks / Trade-offs

- [D1 adds a `collectMigratePlan(..., ["mcp"])` call per present agent
  during the summary step, before a source is even chosen] → this is
  strictly local (file reads / a `codex mcp list --json` subprocess call
  already required later anyway if that agent becomes the source) and
  bounded to the same 4 agents onboard already probes; no new failure
  mode introduced, `collectMigratePlan` already tolerates an absent
  agent/binary by returning zero items.
- [Extracting `printMemorySyncResult` (D3) touches `memory.ts`, a file
  the proposal says should not have its command *behavior* changed] →
  mitigated by keeping this to a pure function-boundary move with
  identical output; existing `test/unit/memory.test.ts` (or wherever its
  tests live) must keep passing unmodified as the behavior-preservation
  check.

## Open Questions

- None — `MemorySyncResult`'s exact shape and `runMemorySync`'s
  exit-code rule were both read directly from `src/commands/memory.ts`
  before writing this design, not assumed.
