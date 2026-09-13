## Why

`trellis mcp sync` has always been create/repair-only (`mcp-server-sync`'s
own live requirement) — deleting a server from `mcp/servers.yaml` never
removed it from any agent's native config, unlike skills (a symlink's own
realpath proves Trellis, not the user, created it). This was a deliberate
deferral, not an oversight, pending "an ownership-tracking mechanism (a
lock file recording what Trellis itself last wrote)" — that mechanism now
exists.

## What Changes

- A new `src/lib/mcpOwnership.ts` ledger (`~/.trellis/mcp/ownership.json`)
  records, per agent and server name, the exact rendered value Trellis
  itself last wrote (a JSON object for Claude Code/Kiro, a TOML section
  string for Codex).
- `resolveMcpPlan`'s three callers (`jsonMcp.ts`'s `planJsonMcp`, and
  `codex.ts`'s own `planMcp`) now also emit `action: "remove"` items — but
  ONLY for a name the ledger says Trellis wrote, whose agent-native
  current content still exactly matches what the ledger recorded. A name
  the user has since hand-edited is left alone, forever, not removed.
- `AdapterPlanItem` gains `mcpRemove?: { name: string }` (the removal
  counterpart to the existing `mcpWrite`) and `action: "remove"` is now a
  real possibility for `kind: "mcp"` (previously documented as never
  used for MCP).
- `applyJsonMcp` deletes a removed key; Codex's adapter calls
  `src/lib/tomlSection.ts`'s pre-existing, already-tested `removeSection`
  (built earlier, never wired into any actual removal path until now).
- pi is unaffected — it has no native MCP config to remove anything from.

**Out of scope, named explicitly, not silently dropped:** MCP *migrate-in*
(importing an already-hand-configured server on an agent into canonical) —
roadmap.md's original P14 paragraph bundled this with removal as "three
distinct, real layers." Removal was the harder, more clearly-specified
half with an existing mechanism (the ledger) to build against; migrate-in
remains a separate, real gap for a future change.

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `mcp-server-sync`: "MCP server sync supports create and repair, not
  automatic removal" becomes "...supports create, repair, and
  ownership-ledger-gated removal."

## Impact

- New: `src/lib/mcpOwnership.ts`.
- Changed: `src/adapters/jsonMcp.ts`, `src/adapters/codex.ts`,
  `src/adapters/claude-code.ts`, `src/adapters/kiro.ts`,
  `src/core/adapter.ts` (`mcpRemove` field, updated doc comment),
  `src/commands/mcp.ts` (report formatting includes removed count).
- No `src/sdk.ts` change — this is adapter/command-internal behavior, not
  a canonical-schema shape change.
