## Why

Dogfooding `mcp sync` against a real machine's actual Codex `config.toml`
(never a synthetic fixture) surfaced two real gaps in the canonical MCP
model, plus one dead field in the shipped example schema. The most
serious gap is silent: migrating a real server (`tanka`) whose Codex
entry uses hardcoded literal `env` values — not the `env_vars`
name-forwarding array other real servers on the same machine use — into
`servers.yaml`'s names-only shape would have `mcp sync` rewrite Codex's
config from working literal values to name-forwarding, and since those
names were never actually exported in Codex's own process environment,
the MCP server would go from connected to silently broken (empty env) —
with neither `mcp sync` nor `secrets audit` warning beforehand. This has
to be fixed before any real migration of an actively-used agent's MCP
servers into canonical is safe to recommend.

## What Changes

- **BREAKING** (schema, additive-only in practice): `McpServerDef` gains
  an `enabled?: boolean` field (default `true`). `resolveMcpPlan` skips
  writing any server with `enabled: false` for every agent, but the
  definition still exists in canonical — matches Codex's own real
  `enabled = false` semantics (a server config kept on hand, deliberately
  off) that canonical currently has no way to represent short of deleting
  the definition outright.
- **BREAKING**: `McpServerDef.env` changes from a bare `string[]` (names
  only) to accept either a name (forwarded from the resolved env source,
  today's only behavior) or an explicit `{name: literalValue}` pair for a
  value that is not a secret and is meant to be written into the agent's
  config verbatim — matching what Codex's own `[mcp_servers.<name>.env]`
  table already supports today outside Trellis. Plain names remain the
  default and recommended form; a literal pair is an explicit, visibly
  different opt-in, never silently inferred.
- `mcp sync` gains a pre-write resolution check: for every name-only
  (non-literal) `env` entry on a server being written for an agent, the
  same env source `secrets audit`/the pi bridge already resolve through
  (`resolveSecretEnv`) must actually produce a value — a name that
  resolves to `undefined` is refused as a new `conflict` kind (with the
  exact env file/process-env source it checked, per
  `secrets.policy.yaml`), never silently written with an empty/missing
  value the way it would be today. `secrets audit`'s existing
  `missing-env-value` check (agent-agnostic, over every name canonical
  declares) already catches this same drift *after* a write; this adds
  the preventive half so a working server is never broken by the write
  itself — no change to `secrets audit`'s own check is needed, both now
  share the same `resolveSecretEnv` call.
- Remove the non-functional `auth: oauth` line from
  `schema/servers.example.yaml`'s `figma` example — `McpServerDef` has no
  `auth` field, `loadServersYaml` performs no field validation, so it was
  silently dropped and never read by any adapter. No spec ever asserted
  this field was supported; this is a documentation-accuracy fix, not a
  requirement change.

## Capabilities

### New Capabilities

(none — both behavior changes extend existing capabilities below)

### Modified Capabilities

- `mcp-server-sync`: add `enabled: false` (defined-but-not-synced)
  support; add the literal (non-secret) env-value form; add the
  pre-write "does this name actually resolve" refusal (reusing
  `secrets-audit`'s existing `resolveSecretEnv` call — no requirement
  change needed on that capability itself).

## Impact

- `src/core/types.ts` — `McpServerDef.enabled`, `McpServerDef.env`'s new
  union shape.
- `src/core/canonical.ts` — `loadServersYaml` (no change needed if it
  stays a passthrough, but the new shape must round-trip through it).
- `src/adapters/mcpPlan.ts` — `resolveMcpPlan` skips `enabled: false`
  servers; new resolution-check conflict path (needs `SecretsPolicy` /
  `resolveSecretEnv` threaded in, which it does not currently receive).
- `src/lib/tomlSection.ts` — `renderServerSection` must render a literal
  env pair as Codex's real `[mcp_servers.<name>.env]` nested table
  instead of `env_vars = [...]` when a server's `env` entries are
  literal.
- `src/commands/mcp.ts`, `src/commands/secretsAudit.ts` — both need the
  extended resolution logic; `secretsAudit.ts`'s `findMissingEnvValues`
  specifically for the "already-synced but now unresolved" case.
- `schema/servers.example.yaml`, `schema/secrets.policy.example.yaml` —
  documentation updates for the new `enabled`/literal-env shapes; removal
  of the dead `auth: oauth` line.
- `docs/getting-started.md`, `docs/roadmap.md`, `README.md` — user-facing
  documentation for the new capabilities and the fixed example.
