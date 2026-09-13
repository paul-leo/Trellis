## 1. TOML env-table reader (Codex static_env)

- [x] 1.1 Add `readServerEnvTable(content, name): Record<string,string> | undefined` to `src/lib/tomlSection.ts`, reusing `findSection`/`envHeader`.
- [x] 1.2 Unit tests: present table, absent table, empty table, quoted keys.

## 2. Migrate-in reader module

- [x] 2.1 Create `src/lib/mcpMigrateRead.ts` with `McpMigrateEntry`/`McpMigrateUnsupported`/`McpMigrateReadResult` types.
- [x] 2.2 `readClaudeCodeMcpDefs(homeDir)` — richer local type with `headers`, converts `~/.claude.json`'s `mcpServers` entries.
- [x] 2.3 `readKiroMcpDefs(homeDir)` — same pattern against `~/.kiro/settings/mcp.json`.
- [x] 2.4 `readCodexMcpDefs(homeDir)` — `codex mcp list --json` for stdio entries (command/args/env names), `readServerEnvTable` for static_env; non-stdio entries → `unsupported` with a named reason.
- [x] 2.5 Unit tests per reader: stdio server with env+static_env+headers where applicable, empty/absent config, codex non-stdio → unsupported.
- [x] 2.6 Round-trip test: write a server via `jsonMcp.ts`'s `renderJsonServerEntry` shape, read it back via the new module, assert `McpServerDef` equality (D2 mitigation).

## 3. Wire into `migrate.ts`

- [x] 3.1 Add `"mcp"` to `MigrateKind` and `MigrateOnlyValue`; update `ONLY_VALUES`/`toMigrateKinds`/error messages.
- [x] 3.2 Add `"skip-unsupported"` to `MigrateAction`.
- [x] 3.3 Add `mcpDef?: McpServerDef` to `MigratePlanItem`.
- [x] 3.4 Add `planMcpServer(name, def, existing)` inline in `migrate.ts`: compares against canonical's current `McpConfig.servers` via `deepEqual`, emits create/already-migrated/conflict items; unsupported entries surface as their own `skip-unsupported` items straight from the reader.
- [x] 3.5 Wire into `collectMigratePlan`'s existing `wants()` gate.
- [x] 3.6 `applyMigratePlan`'s MCP branch: call `upsertServerYaml` for each `"create"` item.
- [x] 3.7 Update `printPlan`'s per-item formatting to handle `kind === "mcp"` and `"skip-unsupported"`.

## 4. Tests

- [x] 4.1 `collectMigratePlan` end-to-end tests per agent: create, already-migrated, conflict, `--only mcp` isolation, pi produces zero MCP items — plus a real-codex-binary end-to-end test in `migrateSources.test.ts` (stdio + static_env recovered from the real `.codex/config.toml`).
- [x] 4.2 `applyMigratePlan` test: a created MCP item actually appears in `servers.yaml` via `upsertServerYaml`'s own round-trip.
- [x] 4.3 `--only bogus` still refuses with the updated three-value message.
- [x] 4.4 Full existing suite still green (no regression to skill/instructions migration) — 341/341 passing.

## 5. Docs

- [x] 5.1 `docs/getting-started.md` — migrate section gains MCP servers, names both fidelity gaps (Codex non-stdio, and that static_env/headers recovery depends on the agent's own real on-disk shape).
- [x] 5.2 `docs/roadmap.md` — close the migrate-in gap named in P14, referencing this change.

## 6. OpenSpec

- [x] 6.1 `openspec validate --strict trellis-migrate-mcp-servers`.
- [ ] 6.2 Archive once all tasks are complete and tests pass.
