## 1. Ownership ledger

- [x] 1.1 `src/lib/mcpOwnership.ts`: `loadMcpOwnership`/`saveMcpOwnership`
      (`~/.trellis/mcp/ownership.json`), `ownedByAgent`, `recordOwned`,
      `forgetOwned` — an unreadable/corrupt ledger is treated as empty,
      never a crash

## 2. Removal-candidate computation, per format

- [x] 2.1 `src/adapters/jsonMcp.ts`'s `planJsonMcp` gains an optional
      `ownership` param; computes removal candidates against
      `existingServers` using the pre-existing `deepEqual`
- [x] 2.2 `src/adapters/jsonMcp.ts`'s `applyJsonMcp` deletes a `"remove"`
      item's key from the merged servers object
- [x] 2.3 `src/adapters/claude-code.ts` and `src/adapters/kiro.ts`: load
      the ledger in `planMcp`, pass this agent's slice; in `apply()`,
      include `"remove"` items in the same write, then update/save the
      ledger (record on create, forget on remove)
- [x] 2.4 `src/adapters/codex.ts`'s own `planMcp` computes removal
      candidates against `currentServerSectionText`; `apply()` calls
      `src/lib/tomlSection.ts`'s pre-existing `removeSection` and updates
      the ledger the same way

## 3. Core type + reporting

- [x] 3.1 `src/core/adapter.ts`: `AdapterPlanItem` gains `mcpRemove?:
      { name: string }`; doc comment updated — MCP `"remove"` is now real
- [x] 3.2 `src/commands/mcp.ts`'s `printReport` counts and prints removed
      items alongside created/conflicts

## 4. Tests

- [x] 4.1 The one existing test asserting the OLD "never removes"
      behavior (`test/unit/mcp.test.ts`) rewritten to assert the new,
      correct behavior: removal happens when unchanged since Trellis
      wrote it, for both Claude Code (JSON) and Codex (TOML)
- [x] 4.2 A hand-edited entry is never removed, even once canonical drops
      it — the user's edit survives untouched
- [x] 4.3 An entry already removed by hand (ledger stale, native config
      already lacks it) produces no plan item and no crash
- [x] 4.4 Full project-wide suite passes with zero regressions

## 5. Documentation

- [x] 5.1 `src/cli.ts`'s `mcp sync` usage text updated to describe
      ownership-ledger-gated removal instead of "no automatic removal"
- [x] 5.2 `docs/roadmap.md`'s P14 entry updated from "(planned)" to "done
      and archived" (removal half) with migrate-in explicitly named as
      still open, once this change is archived
