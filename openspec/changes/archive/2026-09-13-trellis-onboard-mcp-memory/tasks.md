## 1. memory.ts: extract a reusable printer (D3)

- [x] 1.1 Read `test/unit/memory.test.ts` (or wherever memory's tests
      live) fully before touching `memory.ts`, to know what must keep
      passing unmodified.
- [x] 1.2 Extract `runMemorySync`'s inline printing (the `--json` /
      `!result.configured` / configured-with-items branches) into an
      exported `printMemorySyncResult(result: MemorySyncResult, dryRun:
      boolean): void`, called by `runMemorySync` with its own existing
      `opts.dryRun` — output must be byte-identical to before.
- [x] 1.3 Run memory's existing tests; confirm no assertion needed to
      change.

## 2. onboard.ts: MCP-aware summary (D1)

- [x] 2.1 Add `mcpServerCount: number` to `OnboardAgentSummary`.
- [x] 2.2 In `collectOnboardSummary`, compute it via
      `collectMigratePlan(agent, homeDir, ["mcp"]).items.length` for each
      present agent (0 for an absent agent, matching the existing
      early-return shape).
- [x] 2.3 Extend `hasContent` to include `s.mcpServerCount > 0`.
- [x] 2.4 Extend `agentSummaryLabel` to show the MCP count alongside
      skill count / instructions, matching its existing terse style.

## 3. onboard.ts: three-way category selection (D2)

- [x] 3.1 Rewrite `resolveMigrateCategories` to build an ordered
      `{ kind: MigrateKind; label: string }[]` from whichever of
      skill/instructions/mcp have real content (in that display order),
      instead of the current fixed two-slot `wantsSkills`/
      `wantsInstructions` structure.
- [x] 3.2 Show the checkbox (via `opts.promptForMigrateCategories` or the
      real multi-select picker) only when that list has 2 or 3 entries
      and `!opts.json`; render exactly the filtered labels, pre-checked.
- [x] 3.3 When the list has exactly 1 entry, or no picker is available,
      return every kind in the list with no prompt (generalizes today's
      "auto-include whichever kind(s) are real" default).
- [x] 3.4 Confirm `collectMigratePlan`'s consumer in
      `collectOnboardPlan` (the `categories` array passed to it) needs no
      change — it already accepts any `MigrateKind[]`.

## 4. onboard.ts: memory-sync stage (D3, D4, D5)

- [x] 4.1 Import `collectMemorySyncResult`, `applyMemorySync`,
      `printMemorySyncResult`, and `type MemorySyncResult` from
      `./memory.js`.
- [x] 4.2 Add `memorySyncResult?: MemorySyncResult` to `OnboardResult`.
- [x] 4.3 In `collectOnboardPlan`, after `mcpSyncReport` is collected and
      before `secretsAuditReport`, call `collectMemorySyncResult(homeDir)`
      unconditionally (not scoped to `managedAgents`); call
      `applyMemorySync(result)` only when `!opts.dryRun`.
- [x] 4.4 In `printResult`, print the memory-sync stage (via
      `printMemorySyncResult`) between the `mcp sync` block and the
      `secrets audit` block, with a `"\nmemory sync"` heading matching
      the existing style of the other stage headings.
- [x] 4.5 In `runOnboard`'s `hasConflict` computation, fold in
      `result.memorySyncResult?.configured &&
      result.memorySyncResult.plan.items.some(i => i.action ===
      "conflict")` alongside the three existing checks.

## 5. Tests

- [x] 5.1 Read `test/unit/onboard.test.ts` fully before adding to it —
      match its existing fixture/helper conventions exactly.
- [x] 5.2 Test: a source agent with only MCP content (0 skills, no real
      instructions) is a valid `sourceCandidates` entry and gets
      auto-selected/offered like any other source.
- [x] 5.3 Test: two categories present (e.g. skills + mcp, no real
      instructions) offers a checkbox listing exactly those two, not a
      hardcoded three or two-of-a-different-pair.
- [x] 5.4 Test: all three categories present offers a three-way
      checkbox; unchecking one still migrates the other two.
- [x] 5.5 Test: no interactive picker available migrates every category
      that has real content, whatever the count.
- [x] 5.6 Test: `memorySyncResult.configured === false` (no `memory`
      server in servers.yaml) is present in `OnboardResult`, printed, and
      does not by itself flip `runOnboard`'s exit code to 1.
- [x] 5.7 Test: a configured `memory` server with real canonical
      `memories/*.md` content gets its graph file written on a real
      (non-dry-run) onboard run, and left untouched on `--dry-run`.
- [x] 5.8 Test: a memory-sync conflict (existing graph entry diverged
      from canonical) makes `runOnboard` exit non-zero, same as the other
      three stages' conflicts already do.

## 6. Docs

- [x] 6.1 Update `docs/getting-started.md`'s onboard walkthrough to
      mention the three-way category choice and the memory-sync stage.
- [x] 6.2 Update `docs/roadmap.md` with this change's entry (same style
      as the P-numbered entries already there), noting it closes the
      gap found via live dogfooding.
