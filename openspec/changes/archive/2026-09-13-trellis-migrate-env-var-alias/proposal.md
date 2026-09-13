## Why

Confirmed live on a real machine: migrating `notion` from claude-code
broke it on pi. Canonical ended up with
`static_env: { OPENAPI_MCP_HEADERS: "${NOTION_OPENAPI_MCP_HEADERS}" }` —
a genuine env-var reference, misclassified as a literal value — because
`mcpMigrateRead.ts`'s `SELF_VAR_REF_RE` rule only recognizes `${KEY}`
when the referenced name equals the key itself. `OPENAPI_MCP_HEADERS`
referencing a *differently-named* `NOTION_OPENAPI_MCP_HEADERS` falls
through to `staticEnv`, which every renderer treats as an inert literal.
`pi-bridge/index.ts` merges `staticEnv` completely unresolved by design
("a literal, intentionally-plain value") — so the literal placeholder
text `${NOTION_OPENAPI_MCP_HEADERS}` becomes notion's actual
`OPENAPI_MCP_HEADERS` env value, and notion's own `JSON.parse` of it
throws. Confirmed via the real error in a real pi session. Codex's copy
of the same broken value still shows "connected" in its own `/mcp`
panel — real evidence that Codex's own TOML env-table loader does its
own `${VAR}` expansion from its own ambient environment (unverifiable by
reading code alone; this is precisely why the live screenshot is the
evidence, not an assumption).

Migrating a server whose secret can't actually be resolved is worse than
not migrating it at all — it silently changes a working agent into a
crashing one. "Getting the secret" doesn't mean Trellis capturing or
storing a real secret *value* anywhere (that would itself violate this
project's own credential-handling discipline) — it means correctly
recognizing the *reference* (which name to resolve, and under which
target key to deliver it) so every consumer that already knows how to
resolve real env references (pi-bridge's `resolveSecretEnv`, and native
`${VAR}` expansion for claude-code/kiro/codex) actually gets exercised
for this case instead of silently falling into the literal path.

## What Changes

- `mcpMigrateRead.ts` recognizes **any** `${NAME}` value (not just a
  value matching its own key) as a reference needing resolution — not a
  literal.
- `McpServerDef` gains a new field to represent "deliver resolved
  variable `NAME` under a *different* target key" (the self-referencing
  case, where target key and source name are the same, keeps using the
  existing `env: string[]`, unchanged).
- Every writer (`jsonMcp.ts`, `tomlSection.ts`) and pi-bridge's own
  runtime resolution path (`src/pi-bridge/index.ts`) gains support for
  this new field, each using the same delivery mechanism it already uses
  for `env`'s self-referencing case (native `${VAR}` placeholder text for
  claude-code/kiro/codex; real `resolveSecretEnv` resolution for
  pi-bridge, since pi-bridge is Trellis's own code with no native
  runtime to defer to).
- `secrets audit` and `mcp list` continue to only ever handle/print
  variable *names*, never resolved values, for this new field too — no
  change to that discipline.

## Capabilities

### Modified Capabilities
- `canonical-source-migration`: migrate-in's env-reference recognition
  rule changes from "self-referencing only" to "any named reference,
  self- or differently-named."
- `mcp-server-sync`: the write path for claude-code/kiro/codex gains a
  second env-reference form; pi's bridge gains real runtime resolution
  for it (`pi-mcp-bridge` / `pi-bridge-lifecycle` — confirm exact
  existing capability name before writing the delta).

## Impact

- `src/core/types.ts`: `McpServerDef` gains the new field.
- `src/lib/mcpMigrateRead.ts`: `SELF_VAR_REF_RE`/`splitJsonEnvMap`
  (JSON-source path) and `buildCodexMcpReadResult`'s TOML-source path.
- `src/adapters/jsonMcp.ts`: `renderJsonServerEntry`.
- `src/lib/tomlSection.ts`: `renderServerSection`.
- `src/pi-bridge/index.ts`: runtime env resolution.
- No change to `secrets audit`'s scanning logic itself (same names-only
  discipline, one more field to walk).
