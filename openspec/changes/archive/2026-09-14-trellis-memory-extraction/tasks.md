## 1. Slug helper

- [x] 1.1 New (or reused, if an equivalent already exists elsewhere in
      this codebase — check before writing a new one) `slugify(name:
      string): string` — kebab-case, filesystem-safe. If none exists,
      add it to a small shared lib module (not `memoryGraph.ts` itself,
      to keep that module scoped to graph<->canonical conversion).
- [x] 1.2 Unit tests: spaces, mixed case, and punctuation all produce a
      valid, stable slug; two different inputs that would slug
      identically are surfaced as-is (the collision itself is handled at
      the planning layer, task 2 — this layer just slugifies).

## 2. Extraction planning (pure)

- [x] 2.1 `src/lib/memoryGraph.ts`: new `planMemoryExtraction(graphLines:
      readonly MemoryGraphLine[], existingCanonicalNames: Set<string>,
      readCanonicalFile: (name: string) => string | undefined):
      MemoryExtractionPlan` — pure, given the parsed graph and a way to
      check/read existing canonical files (mirrors `planMemorySync`'s
      own pure-given-inputs shape, no direct fs access inside).
- [x] 2.2 Candidate detection (D1): entity, `entityType !==
      TRELLIS_MEMORY_ENTITY_TYPE`, at least one observation.
- [x] 2.3 Render function `renderExtractedMemoryFile(entity, relations):
      string` per D2's exact shape — heading, Type, Observations,
      optional Relations section.
- [x] 2.4 Slug + create/no-op/conflict decision per candidate (D3, D4) —
      including the same-slug-collision-is-a-conflict case.
- [x] 2.5 Unit tests covering every scenario in
      `specs/memory-extraction/spec.md`: candidate detection (positive
      and both negative cases), render shape (with and without
      relations), slug derivation reflected in the target path, all four
      create/no-op/conflict/collision scenarios.

## 3. `trellis memory extract` command

- [x] 3.1 `src/commands/memory.ts`: `collectMemoryExtractionResult(homeDir)`
      — reuses the exact same `memory` server / `MEMORY_FILE_PATH`
      resolution `collectMemorySyncResult` already has (share the lookup,
      don't re-derive it) — same "not configured" result shape/message on
      refusal.
- [x] 3.2 `applyMemoryExtraction(result)` — writes each `"create"` item's
      file (`mkdirSync` the `memories/` dir if needed, matching
      `applyMemorySync`'s own posture).
- [x] 3.3 `runMemoryExtraction(opts)` — same `--dry-run`/`--json`
      conventions as `runMemorySync`; exit code non-zero only on a real
      conflict, same posture as every other command.
- [x] 3.4 `src/cli.ts`: register `extract` in the existing `command ===
      "memory"` dispatch, alongside `sync`; update the `Unknown memory
      subcommand` usage message.
- [x] 3.5 Integration tests (scratch `homeDir`, a hand-written graph
      file): full command run creates expected files; `--dry-run`
      previews without writing; `--json` reports structured results; "not
      configured" refuses with `memory sync`'s exact message.

## 4. Docs

- [x] 4.1 `docs/getting-started.md`: document `trellis memory extract`
      alongside `memory sync`, including the lossy-round-trip trade-off
      (D2/Risks) stated plainly so a user isn't surprised later.
- [x] 4.2 `docs/architecture.md` / `docs/research.md`: note the
      one-directional-each-way shape of the two memory commands together
      (sync: canonical -> graph; extract: graph -> canonical), so the
      overall picture reads as one coherent story, not two disconnected
      commands.
- [x] 4.3 `docs/roadmap.md`: new entry, closing P15's own explicitly-named
      "per-agent extraction into canonical remains a separate, open gap."
