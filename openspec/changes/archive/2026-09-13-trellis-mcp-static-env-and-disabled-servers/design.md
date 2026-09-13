## Context

Dogfooding `mcp sync` against this machine's real, actively-used Codex
`config.toml` (not a fixture) found:

- `[mcp_servers.supabase_db]` has `enabled = false` — a definition kept
  on hand, deliberately off. `McpServerDef` has no way to represent this;
  `servers.yaml` either has the definition (always live for every
  managed agent) or doesn't (lost).
- `[mcp_servers.tanka]` uses a literal nested `env` table
  (`TANKA_EMAIL = "..."`, `TANKA_ENV = "..."`) — hardcoded values, not
  the `env_vars = [...]` name-forwarding array other real servers on the
  same file (`mcp_router`, `notion`, `gitlab`) use. `McpServerDef.env` is
  `string[]` — names only, always resolved from an external source
  (`resolveSecretEnv`) — there is no way to express "these are literal,
  intentionally-plain values, write them as-is."

Both gaps sit on the same read path (`resolveMcpPlan`, shared by all
three JSON/TOML adapters via `mcpPlan.ts`), so they're one change.

Separately, `schema/servers.example.yaml`'s `figma` example documents
`auth: oauth` — a field `McpServerDef` doesn't have and no code reads;
`loadServersYaml` does zero field validation, so it's silently dropped.
No live spec ever asserted this field was supported (confirmed: no
`auth`/`oauth` mention in any `openspec/specs/*/spec.md`) — a
documentation-accuracy fix, not a requirement change.

## Goals / Non-Goals

**Goals:**
- Represent Codex's real `enabled = false` semantics in canonical
  without losing the definition.
- Represent a genuinely-non-secret literal env value (an email, an
  environment tag — not a credential) without violating the existing
  "canonical never stores literal secret values" discipline for actual
  secrets.
- Make `mcp sync` refuse to write a name-only env reference that
  wouldn't actually resolve, instead of writing it and letting a
  separately-run `secrets audit` discover the breakage afterward.
- Fix the dead `auth: oauth` example line.

**Non-Goals:**
- Auto-detecting "is this value a secret" — `staticEnv` is an explicit,
  visibly-different field the user opts into per entry; the existing
  `reject_patterns` literal scan remains the only backstop, applied to
  `staticEnv` values exactly like every other literal field already
  scanned.
- Any new capability for pi — pi's bridge already goes through
  `resolveSecretEnv` for every name-only entry; whether pi's own native
  settings format has any use for a literal, non-secret value is an open
  question (see below), not assumed needed by this design.
- OAuth support for `http`/`sse` transports — this change only removes
  the dead field; implementing real OAuth is out of scope.

## Decisions

**D1 — separate field, not a mixed-shape `env` array.**
`McpServerDef` gains `staticEnv?: Record<string, string>`, distinct from
the existing `env?: string[]`. Considered making `env` accept
`(string | {name: string; value: string})[]` instead — rejected: it
makes every `env` entry's meaning conditional on its shape, breaks
`env`'s current 100%-backward-compatible "always names" contract for
every existing `servers.yaml`, and is harder to read in YAML. A separate
field keeps each one unambiguous by name alone.

**D1a — on-disk YAML key is `static_env` (found during implementation,
not anticipated here originally).** Every other multi-word key across
`.trellis/*.yaml` is snake_case, explicitly translated to camelCase in
its loader (`known_host_injected` → `knownHostInjected`,
`allowed_vars` → `allowedVars`) — but `McpServerDef` had always been
parsed directly, as-is, with zero field translation, since every prior
field name happened to already be a single word. `loadServersYaml` now
maps a per-server `static_env` YAML key to `McpServerDef.staticEnv`
before the rest of the pipeline ever sees it, matching the established
convention rather than introducing the first camelCase key in the whole
project's YAML surface.

**D2 — `staticEnv` still passes through the literal-secret scan.**
`mcpPlan.ts`'s `findLiteralSecret` (today scanning `command`, `url`,
`args`, `headers`) is extended to also scan `Object.values(def.staticEnv
?? {})`. `staticEnv` is for values that aren't secrets in the first
place — if a real credential shape lands there anyway, refusing it is
the same protection every other literal field already gets, not a
special case.

**D3 — Codex TOML: literal env renders as a second, adjacent table.**
When `def.staticEnv` is set, `renderServerSection` emits BOTH
`[mcp_servers.<name>]` (command/args, `env_vars` for any *separate*
name-only entries) AND `[mcp_servers.<name>.env]` with the literal
`key = "value"` lines — matching Codex's own real shape exactly.
`tomlSection.ts`'s section-boundary functions (`findSection`,
`currentServerSectionText`, `upsertSection`, `removeSection`) are
extended to treat an immediately-following `[<header>.env]` table as
owned by the same logical server entry when `staticEnv` is present, so
create/repair/remove treat the pair atomically. Reuses the existing
`isTableHeaderLine` boundary detection already hardened against the
real fixture regressions noted in that file's own comments (blank-line
and trailing-comment edge cases) — no new parsing primitive.

**D4 — JSON (Claude Code/Kiro): literal and name-referenced env values
coexist in the same map.**
`renderJsonServerEntry`'s `entry.env` becomes
`{ ...Object.fromEntries(env.map(n => [n, "${" + n + "}"])), ...staticEnv
}`. JSON's `env` object has no structural distinction between a `${VAR}`
reference and a literal string the way Codex's TOML has two genuinely
separate constructs — both forms already fit the same map without any
new shape.

**D5 — `enabled: false` is filtered in `resolveMcpPlan` itself.**
Every JSON and TOML adapter already funnels through this one function —
the single choke point. A disabled server produces neither a `desired`
entry nor a `conflict`; it's invisible to that agent's report, matching
the existing convention that an unmanaged agent gets no report line at
all (rather than a zero-item line).

**D6 — pre-write resolution check needs `SecretsPolicy` threaded into
`resolveMcpPlan`.**
`resolveMcpPlan(agentId, mcp, managedAgents)` gains a required fourth
parameter, `policy: SecretsPolicy`. For every name-only `env` entry on a
server about to be written, resolve it via the same `resolveSecretEnv`
`secrets audit` and the pi bridge already call; any name resolving to
`undefined` becomes a new conflict (`unresolved-env-value`), refusing
that one server for that one agent — every other server, and every
other agent, proceeds normally (same "one conflict never blocks another
path" pattern already established for `known_host_injected` collisions
and literal-secret refusals in this same function).

**D7 — no change needed to `secrets audit` itself.**
Its `missing-env-value` check already iterates every name declared
across canonical's `servers.yaml`, agent-agnostically, independent of
whether anything's actually been synced yet — it already catches the
exact "declared name doesn't resolve" case D6 prevents at write time.
D6 and `secrets audit` end up calling the identical `resolveSecretEnv`
function; this is the preventive half, `secrets audit` remains the
detective half for later drift (the resolving source changing after a
successful, valid-at-the-time sync).

## Risks / Trade-offs

- [Risk] `staticEnv` becomes a plausible place to accidentally put a
  real secret, since it's explicitly the "literal value" field. →
  Mitigation: D2 — same `reject_patterns` scan every other literal field
  already gets, no exemption.
- [Risk] D3's two-adjacent-table TOML rendering is real added complexity
  in a module whose own docstring already explains why a general TOML
  parser was rejected for this exact kind of edge case. → Mitigation:
  extend the same hardened boundary primitives rather than writing new
  ones; add fixture tests mirroring the existing blank-line/
  trailing-comment cases already covered for the single-table case.
- [Risk] D6 changes `resolveMcpPlan`'s signature — every call site
  (`codex.ts`, `claude-code.ts`, `kiro.ts`, `jsonMcp.ts`'s
  `planJsonMcp`) must be updated. → Mitigation: mechanical and
  compiler-enforced; same "make it impossible to forget" reasoning as
  `trellis-backup-rollback`'s mandatory `BackupSession` parameter — a
  server silently written with an unresolvable env value is exactly the
  class of bug that motivated that earlier change too.

## Migration Plan

Purely additive on disk: `enabled` defaults to `true` when absent,
`staticEnv` defaults to absent/empty. No existing `servers.yaml` needs
rewriting to keep behaving exactly as it does today. Every write from
the new code paths still flows through `apply(plan, backup)` from
`trellis-backup-rollback` — a `mcp sync` run using these new fields is
already covered by `trellis rollback` with no further change there.

## Open Questions

- Does pi's own bridge/settings format have any use for a literal,
  non-secret env value, or does its model only ever make sense as
  resolved-from-source? Not assumed either way here — check pi's actual
  settings schema during implementation and scope `staticEnv` support
  for pi accordingly (task, not a design blocker).
- Exact conflict message wording for `unresolved-env-value` should match
  `mcpPlan.ts`'s existing message style (`collisionMessage`, the
  literal-secret refusal) — finalize during implementation.
