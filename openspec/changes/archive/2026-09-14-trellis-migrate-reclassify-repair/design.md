## Context

`planMcpServer` (`src/commands/migrate.ts`) today has exactly three
outcomes for an MCP server migrate item: `"create"` (no existing
canonical entry), `"already-migrated"` (`deepEqual(existing, def)`), or
`"conflict"` (anything else — always "resolve by hand," never applied by
`applyMigratePlan`). There is no notion of "structurally different, but
provably the same source value" — every real customization and every
stale-due-to-a-Trellis-classification-fix entry lands in the same bucket.

Confirmed real, on this machine: `~/.trellis/mcp/servers.yaml`'s `notion`
entry still has `static_env: { OPENAPI_MCP_HEADERS:
"${NOTION_OPENAPI_MCP_HEADERS}" }` from before
`trellis-migrate-env-var-alias` shipped. Re-reading from claude-code
today correctly classifies this as `envAliases: { OPENAPI_MCP_HEADERS:
"NOTION_OPENAPI_MCP_HEADERS" }` — but `planMcpServer` sees these two
`McpServerDef`s as structurally different and reports a conflict, so
re-running migrate does not repair it.

`renderJsonServerEntry` (`src/adapters/jsonMcp.ts`) already builds
exactly the "resolved text form" this design needs for comparison:
```
const nameRefs = Object.fromEntries((def.env ?? []).map((name) => [name, `\${${name}}`]));
const aliasRefs = Object.fromEntries(Object.entries(def.envAliases ?? {}).map(([targetKey, sourceName]) => [targetKey, `\${${sourceName}}`]));
const env = { ...nameRefs, ...aliasRefs, ...(def.staticEnv ?? {}) };
```
This design extracts that exact logic into a shared helper both
`renderJsonServerEntry` and the new reclassify check use — the same
mechanism, not a second, parallel derivation of it.

## Goals / Non-Goals

**Goals:**
- Re-running `trellis migrate --only mcp` after a migrate-read
  classification fix ships repairs an already-migrated, now-stale entry
  automatically, when doing so is provably safe.
- Never weaken the existing "a real customization is never silently
  overwritten" guarantee — anything beyond a pure env-classification
  shuffle still conflicts exactly as before.
- Make the repair visibly distinct in `migrate`'s own output from a
  brand-new `"create"`, so a user can tell the two apart.

**Non-Goals:**
- No general "auto-resolve any conflict" framework — this is one narrow,
  precisely-scoped rule specific to the `env`/`envAliases`/`staticEnv`
  classification shuffle, not a template for future conflict types to
  reuse blindly. A future classification change gets its own narrow rule
  if and when it needs one.
- No change to `mcp sync`'s own conflict/repair semantics (that's a
  different capability, `mcp-server-sync`, already correct for its own
  concern — this only touches migrate-read's own conflict detection).

## Decisions

**D1 — Shared `resolvedEnvTextMap(def)` helper**, extracted from
`renderJsonServerEntry`'s existing inline logic into
`src/lib/mcpMigrateRead.ts` (the module that already owns the inverse
operation, `splitJsonEnvMap`) and exported. `renderJsonServerEntry` calls
it instead of re-deriving the same three lines inline — a refactor, not a
behavior change (existing render tests must keep passing unmodified).

**D2 — Safe-reclassification check.** Given `existing` and a freshly-read
`def` for the same server name, where `deepEqual(existing, def)` is
already false (so `planMcpServer` would otherwise conflict): compute
`{ env: _e, envAliases: _ea, staticEnv: _se, ...restExisting } = existing`
and the same split for `def`. The pair is a safe reclassification, not a
conflict, iff:
1. `deepEqual(restExisting, restDef)` — every field outside the
   env-classification trio (`command`, `args`, `url`, `headers`,
   `transport`, `enabled`, `agents`) is identical.
2. `deepEqual(resolvedEnvTextMap(existing), resolvedEnvTextMap(def))` —
   the same keys resolve to the exact same literal/reference text, only
   filed under a different one of `env`/`envAliases`/`staticEnv`.

**D3 — New `MigrateAction` value: `"reclassify"`.** Applied by
`applyMigratePlan` exactly like `"create"` (same `upsertServerYaml` call,
`def` from the fresh read) — extends the existing `item.action !==
"create"` guard to `item.action !== "create" && item.action !==
"reclassify"`. Reported with its own detail text ("same value, only its
internal classification changed — safe to update") so `migrate`'s
generic `[${action}] ${label} — ${detail}` printer shows it distinctly
from a real `"create"` without any printer code changes (the printer is
already action-agnostic).

**D4 — Everything else still conflicts.** Any difference D2's two checks
don't both cover — a real value change, a different command, a genuinely
added/removed field — falls through to the existing `"conflict"` path,
completely unchanged. This check only ever *narrows* what counts as a
conflict; it never widens what migrate is willing to touch.

## Risks / Trade-offs

- **[Risk] A hand-crafted `${...}` value that isn't actually a variable
  reference at all (e.g. a literal string a user genuinely wants to
  contain literal `${...}` text) could, in theory, collide with this
  check** → not realistically distinguishable from a real reference by
  either this check or the original classification logic; already an
  accepted, pre-existing limitation of `env`/`envAliases`/`staticEnv`
  classification itself (D2's own `VAR_REF_RE`), not newly introduced
  here.
- **[Trade-off] Narrow, single-purpose rule, not a general framework** →
  intentional (see Non-Goals); a future similar situation gets its own
  rule reviewed on its own merits, not blanket-approved by this one.

## Migration Plan

Purely additive to `migrate.ts`'s own internal logic — no schema change,
no new file, no change to any other command. Existing tests for
`"conflict"` and `"already-migrated"` must keep passing unmodified;
new tests cover the new `"reclassify"` path specifically.
