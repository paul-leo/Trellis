## 1. Shared helpers (extract, don't duplicate)

- [x] 1.1 `src/lib/dirEquals.ts` gains `decideDirImport(sourceDir,
      canonicalDir): "create" | "already-present" | "conflict"`,
      wrapping the exact `existsSync`/`dirContentsEqual` sequence
      already inline in `migrate.ts`'s `planSkill`
- [x] 1.2 `src/commands/migrate.ts`'s `planSkill` refactored to call
      `decideDirImport` instead of its own inline check (design.md
      D2 — behavior-preserving, not a feature change)
- [x] 1.3 Full existing `test/unit/migrate.test.ts` suite (16 tests)
      passes unmodified after the refactor

## 2. `src/core/canonical.ts` gains a `servers.yaml` writer

- [x] 2.1 `toServerDefYaml(def: McpServerDef): McpServerDefYaml` — the
      inverse of the existing `fromServerDefYaml`, camelCase `staticEnv`
      → snake_case `static_env`
- [x] 2.2 `upsertServerYaml(path, name, def)` and
      `removeServerYaml(path, name)` — both use the `yaml` package's
      `parseDocument`/`setIn`/`deleteIn`/`toString` (design.md D3), never
      `parse` + rebuild + `stringify`; refuse cleanly (no write) if the
      file fails to parse at all

## 3. `trellis skill` command (new)

- [x] 3.1 New `src/commands/skill.ts`: `collectSkillListPlan` (reads
      canonical skills + resolves scope via `resolveScope`),
      `collectSkillAddPlan`/`applySkillAddPlan` (uses `findSkillFile`
      for source validation, `decideDirImport` for the conflict
      decision), `collectSkillRemovePlan`/`applySkillRemovePlan`
- [x] 3.2 `src/cli.ts` gains the `skill` command (`list`, `add
      <name> --from <path>`, `remove <name>`), each with
      `--dry-run`/`--json` matching every existing command's parsing
      convention

## 4. `trellis mcp` command gains list/add/remove

- [x] 4.1 `src/commands/mcp.ts` gains `collectMcpListPlan` (reads
      `servers.yaml` via the existing loader, no secret resolution —
      design.md D6), `collectMcpAddPlan`/`applyMcpAddPlan` (refuses on
      an existing name, no `--force` — design.md D4), and
      `collectMcpRemovePlan`/`applyMcpRemovePlan` (canonical-side only,
      never touches an agent's native config)
- [x] 4.2 `src/cli.ts`'s `mcp` command gains `list`, `add <name> ...`,
      `remove <name>` alongside its existing `sync` subcommand, each
      with `--dry-run`/`--json`
- [x] 4.3 `mcp add`'s flag parsing: `--transport stdio|http|sse`,
      `--command`, `--args` (comma-separated), `--env` (comma-separated
      names), `--static-env` (comma-separated `k=v`), `--headers`
      (comma-separated `k=v`, values expected as `${VAR}` references),
      `--agents` (comma-separated agent ids), `--enabled true|false`
      (default true)
- [x] 4.4 Existing `trellis mcp sync` behavior and its own tests are
      unaffected by the new subcommands sharing the `mcp` command

## 5. Tests

- [x] 5.1 `skill list`: unscoped skill resolves to full managed set;
      scoped-outside-managed-set skill resolves to the intersection
- [x] 5.2 `skill add`: valid source copied in; missing `SKILL.md`
      refuses; wrong-case `skill.md` refuses; re-add of identical
      content is a no-op; re-add of differing content is a conflict,
      not overwritten
- [x] 5.3 `skill remove`: existing skill's canonical directory deleted;
      non-existent skill refuses cleanly; a subsequent `sync` removes
      the now-stale symlink on a previously-synced agent (end-to-end,
      not just canonical-side)
- [x] 5.4 `mcp list`: env names shown without resolution; static_env
      values shown in full; disabled server still listed, marked
      disabled
- [x] 5.5 `mcp add`: new stdio server added, rest of `servers.yaml`
      byte-for-byte unchanged elsewhere (a file with pre-existing
      comments, to actually prove D3's preservation claim); new
      http/sse server with static_env added; adding over an existing
      name refuses, no write
- [x] 5.6 `mcp remove`: existing entry removed from `servers.yaml`
      only, confirmed no agent's native config is touched even when
      that agent already has the same-named server from an earlier
      `mcp sync`; non-existent name refuses cleanly
- [x] 5.7 `--dry-run` on each of `skill add`/`skill remove`/`mcp add`/
      `mcp remove`: plan computed, zero writes
- [x] 5.8 Full project-wide suite passes unmodified alongside the new
      tests

## 6. Documentation

- [x] 6.1 `docs/getting-started.md` gains a section (or an addition to
      "Starting from nothing") documenting `skill`/`mcp`
      `list`/`add`/`remove`, cross-referencing that MCP removal here is
      canonical-only (linking to the same "Known limitations"
      framing `mcp sync`'s own removal gap already uses)
- [x] 6.2 `docs/roadmap.md`'s P12 entry updated from "(planned)" to
      "done and archived" with the real archive path, once this change
      is archived
