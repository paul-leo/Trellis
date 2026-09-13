## Why

`trellis migrate --from <agent>` imports an existing agent's real
skills and instructions into canonical source, but never its MCP
servers — each static-config probe (`codex.ts`/`claude-code.ts`/
`kiro.ts`) reads a server's full real definition and discards it down
to `doctor`'s thin `{name, transport, probe?}` shape. Someone who
already has hand-configured MCP servers on one agent today has no way
to bring them into `~/.trellis/mcp/servers.yaml` short of retyping
them by hand with `trellis mcp add` — this was named as a real,
deliberately-deferred gap in both P14 (`trellis-mcp-sync-removal`,
scoped to removal only) and the current `docs/roadmap.md`.

## What Changes

- `trellis migrate --from <agent>` gains a third category, `mcp`,
  alongside the existing `skill`/`instructions`: `--only mcp` migrates
  just MCP servers; omitting `--only` now migrates all three.
- New per-agent MCP-definition readers for claude-code, kiro, and
  codex — each converts that agent's own real, already-configured MCP
  server into canonical's `McpServerDef` shape. **pi has no static
  config to read at all** (confirmed in P14/roadmap.md) — excluded
  from this capability entirely, not attempted.
- Two genuine fidelity gaps, found by reading each agent's actual
  on-disk/subprocess-output shape rather than assumed, are handled by
  refusing to migrate what can't be safely represented rather than
  guessing:
  - **Codex**: `codex mcp list --json` only ever reports `env_vars`
    (variable *names*), never `static_env`'s literal values (which
    live in a separate `[mcp_servers.<name>.env]` TOML table) or any
    http/sse-transport field (`url`, `bearer_token_env_var`) — this
    codebase has never even read those fields for Codex, not just
    failed to migrate them. Codex migrate-in is scoped to **stdio
    transport only**; a non-stdio Codex server is reported as
    unsupported, not silently dropped or guessed at.
  - **claude-code / kiro**: both probes' own JSON server-def types are
    missing `headers`, a field Trellis's own writer
    (`jsonMcp.ts`) already writes for http/sse servers into that exact
    same on-disk shape. A new, richer type scoped only to this
    migrate-in reader recovers it — the existing probe-facing types
    (used by `doctor`, extensively tested) are left untouched.
- Same conflict posture as skill/instructions migration throughout: a
  name that already exists in canonical with different real content is
  refused, never silently overwritten; identical content is a no-op.

## Capabilities

### New Capabilities
(none — this extends an existing capability's behavior)

### Modified Capabilities
- `canonical-source-migration`: `--only` gains a third accepted value
  (`mcp`); a new requirement covers reading, converting, and
  conflict-checking each agent's real MCP servers into
  `~/.trellis/mcp/servers.yaml`; the existing "instructions migrate
  only into empty/placeholder" and "migrated content is not scoped to
  source agent" requirements are unaffected in substance but the
  `--only` enum requirement itself needs its valid-values list updated.

## Impact

- `src/commands/migrate.ts` — `MigrateKind`/`MigrateOnlyValue` gain
  `"mcp"`; `MigratePlanItem` gains an `mcpDef?: McpServerDef` field and
  a new `"skip-unsupported"` action; `collectMigratePlan`/
  `applyMigratePlan` gain an MCP branch.
- New file `src/lib/mcpMigrateRead.ts` — per-agent readers, kept
  separate from each probe's own `AgentSnapshotMcpServer` type (no
  change to `src/probes/*.ts`'s existing, tested read-side shapes).
- `src/lib/tomlSection.ts` gains a new function to read a Codex
  server's `[mcp_servers.<name>.env]` table's literal `static_env`
  values (the one piece `codex mcp list --json` can't recover).
- `src/core/canonical.ts`'s existing `upsertServerYaml` (built for
  P12) is reused, unchanged, as the write path into `servers.yaml`.
- `docs/getting-started.md`/`docs/roadmap.md` updated to reflect this
  gap as closed, with both fidelity limitations named explicitly.
