## Context

`mcpPlan.ts`'s own header comment and `mcp-server-sync`'s live spec both
name the exact reason removal was deferred: no ownership marker exists for
a bare TOML/JSON key. `src/lib/tomlSection.ts` already had a fully-built,
already-tested `removeSection` function (a byproduct of the static-env
atomic-range work), sitting unused — codex.ts never called it.

## Goals / Non-Goals

**Goals:**
- Make MCP removal provably safe: only remove an entry whose current
  native content still exactly matches what Trellis itself last wrote.
- Reuse `removeSection` (codex) rather than rebuild it; reuse each
  format's own existing equality check (`deepEqual` for JSON, `===` for
  TOML text) for the "unchanged since" comparison, rather than a second,
  parallel hash-based mechanism.

**Non-Goals:**
- MCP migrate-in (import) — a real, separate gap, named in proposal.md,
  not attempted here.
- Any change to hub mode's removal behavior — hub mode's own early-return
  in `resolveMcpPlan` is untouched; hub mode only ever has one entry
  (`trellis-hub`) in practice, and its own removal story is a smaller
  edge case explicitly deferred, not silently assumed solved.
- Any change to `kiroAgent.mcpApprovedEnvVars`'s additive-only contract
  (trellis-kiro-approved-env-vars design.md D3/D4) — approved env vars
  stay additive regardless of MCP server removal, untouched by this
  change.

## Decisions

**D1 — The ledger stores the exact rendered value, not a hash.** A hash
would need a canonical serialization to be stable across `JSON.stringify`
key-ordering concerns; storing the rendered value itself and reusing each
format's own existing comparison function (`deepEqual` for the JSON
agents' plain objects, `===` for Codex's TOML section text) sidesteps that
entirely and reuses code already proven correct by this project's own
existing tests.

**D2 — Removal-candidate computation lives in each format-specific
planner, not in `resolveMcpPlan` itself.** `resolveMcpPlan` stays
storage-agnostic and unchanged in signature/return shape — it has no way
to read an agent's current native content itself (that's each adapter's
own file-format concern). Each of `planJsonMcp`/`codex.ts`'s `planMcp`
independently computes `desiredNames` from `resolveMcpPlan`'s own
`desired` output, then checks its own agent's ownership-ledger slice
against its own agent's current native content.

**D3 — The ledger is read/written directly inside each adapter's private
`planMcp`/`apply()`, not threaded through `TrellisAdapter.plan()`'s public
interface.** Each adapter's `planMcp` already does its own raw file I/O
for the native config (`existsSync`/`readFileSync` right there) — reading
one more small JSON file in the same place is the least invasive option,
requiring zero changes to `TrellisAdapter`'s public method signature,
`CanonicalSource`, or any command-layer call site.

**D4 — The ledger is NOT written through `BackupSession`.** `backup.ts`'s
session exists to make an agent-visible file's writes revertible via
`trellis rollback`; the ownership ledger is Trellis's own private
bookkeeping, not an agent-visible file, and is self-healing regardless: if
a sync run is rolled back, the corresponding native config reverts too,
and a later sync's "is this still what we wrote" check naturally
re-evaluates against whatever content actually exists.

## Risks / Trade-offs

- [A ledger entry survives across a manual, out-of-band edit to
  `ownership.json` itself] → this file is Trellis's own directory
  (`~/.trellis/mcp/`), not meant for hand-editing; an unreadable/corrupt
  ledger is treated as empty (`loadMcpOwnership`'s own catch), never a
  crash.
- [Hub mode's own removal path isn't covered] → named above as a
  Non-Goal; hub mode's single-entry shape makes this a much smaller
  practical gap than per-server removal was.

## Migration Plan

Additive to existing behavior — a server nobody's ever synced (no ledger
entry) is completely unaffected; only names the ledger already tracks can
ever become removal candidates. No existing test's assertions about
create/repair/conflict behavior change; only the one test asserting the
OLD "never removes" behavior needed rewriting to assert the new, correct
behavior instead (test/unit/mcp.test.ts).

## Open Questions

None outstanding.
