## 1. Graph parsing/rendering + sync planning

- [x] 1.1 `src/lib/memoryGraph.ts`: `parseMemoryGraph`/`renderMemoryGraph`
      (JSON-lines, malformed lines skipped, not fatal — design.md D5)
- [x] 1.2 `planMemorySync`: pure, computes create/already-synced/remove/
      conflict per canonical memory, using `entityType: "trellis-memory"`
      as the in-band ownership marker (design.md D1); every other line
      passes through untouched unconditionally (design.md D4)

## 2. `trellis memory sync` command

- [x] 2.1 `src/commands/memory.ts`: `collectMemorySyncResult` (locates
      the `memory` server's `static_env.MEMORY_FILE_PATH`, reports a
      clean no-op if absent), `applyMemorySync`, `runMemorySync`
- [x] 2.2 `src/cli.ts` gains the `memory` command (`sync` only, for
      now), with `--dry-run`/`--json` matching every existing command

## 3. Documentation

- [x] 3.1 `schema/servers.example.yaml`'s `memory` example documents
      `static_env.MEMORY_FILE_PATH` and why it must be set explicitly
- [x] 3.2 `docs/getting-started.md` gains a `trellis memory sync`
      section, explicitly naming the Claude-Code-memory-extraction gap
      as still open
- [x] 3.3 `docs/roadmap.md`'s P15 entry updated from "(planned)" to
      "done — ingestion half only" with the real archive path, once
      this change is archived; the per-agent-extraction half named as a
      still-open, separate gap

## 4. Tests

- [x] 4.1 `test/unit/memoryGraph.test.ts`: parse/render round-trip,
      create/already-synced/update/remove/conflict decisions, untouched
      passthrough for non-Trellis entities and relations
- [x] 4.2 `test/unit/memory.test.ts`: unconfigured no-op, real ingestion,
      `--dry-run`, removal-on-next-sync leaving runtime content
      untouched, conflict refusal
- [x] 4.3 Full project-wide suite passes with zero regressions
