## 1. Core

- [x] 1.1 `src/core/adapter.ts`: extended `AdapterPlanItem.kind` with
      `"kiro-approved-env-vars"`; added `approvedEnvVars?: string[]`.
- [x] 1.2 `src/adapters/kiro.ts`: `desiredApprovedEnvVars()` collects
      every unique `env` name from
      `resolveMcpPlan("kiro", canonical.mcp).desired` (design.md D2);
      `planApprovedEnvVars()` reads the current array from
      `~/Library/Application Support/Kiro/User/settings.json` (a parse
      failure yields a `"conflict"` item, design.md D3), computes the
      union, and emits a `"kiro-approved-env-vars"` create item only
      when the union differs from what's already present (design.md D4).
- [x] 1.3 `KiroAdapter.apply()`: handles the new kind — parses the whole
      settings.json (or `{}`), spreads every existing key through,
      overwrites only `kiroAgent.mcpApprovedEnvVars`.
- [x] 1.4 `KiroAdapter.verify()`: re-reads the real file and flags any
      name `desiredApprovedEnvVars()` needs that isn't present.

## 2. Unit tests

- [x] 2.1 `test/unit/kiroApprovedEnvVars.test.ts` (6 tests, all pass):
      appends to an existing array without dropping entries; a
      scoped-away server contributes nothing; a
      `known_host_injected`-collision server contributes nothing;
      already-correct state yields zero plan items; a malformed
      settings.json yields a conflict and the file is left byte-for-byte
      unchanged after `apply()`; a real `apply()` preserves unrelated
      top-level keys (`editor.fontSize`, `workbench.startupEditor`).
      Full suite: 124/124 pass (118 pre-existing + 6 new).

## 3. Sandbox verification (real container)

- [x] 3.1 No Dockerfile change needed — the shared fixture's existing
      `mcp/servers.yaml` (`sample-server`, unscoped, `env: [SAMPLE_TOKEN]`)
      already exercises this end-to-end with zero extra seeding. Ran
      real `trellis sync` in `docker/sandbox.Dockerfile` twice:
      - First run (no pre-existing Kiro global settings.json): CLI
        reported `[create] .../Kiro/User/settings.json:
        kiroAgent.mcpApprovedEnvVars updated to include SAMPLE_TOKEN`;
        the real file was created containing exactly
        `{"kiroAgent.mcpApprovedEnvVars": ["SAMPLE_TOKEN"]}`.
      - Second run, pre-seeded with
        `{"kiroAgent.mcpApprovedEnvVars":["SAMPLE_TOKEN"],"unrelated.setting":true}`:
        kiro's report dropped from 2 created items to 1 (only the skill
        symlink — no `kiro-approved-env-vars` item at all, confirming
        idempotency), and the file came out byte-identical, including
        `unrelated.setting` — confirming the whole-file-preserved
        write discipline in a real run, not just a unit test.

## 4. Docs

- [x] 4.1 `docs/roadmap.md`: added this phase's entry, citing the real
      finding (Kiro's own `expandEnvironmentVariables` source, its
      `mcpApprovedEnvVars` gate, and this machine's own `mcp-router`
      entry needing a literal value because of it).
