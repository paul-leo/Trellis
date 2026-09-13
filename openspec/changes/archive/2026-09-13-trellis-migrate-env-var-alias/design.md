## Context

`McpServerDef.env: string[]` only expresses "target key X gets the
resolved value of a variable named X" — self-referencing by
construction. Every real target already knows how to deliver that: for
claude-code/kiro, `renderJsonServerEntry` writes a literal `"${X}"`
placeholder into the JSON `env` object and trusts their own native
runtime to expand it from its own ambient environment; for codex,
`renderServerSection` writes bare names into `env_vars` and trusts
Codex's own runtime the same way; for pi (Trellis's own bridge code, no
native runtime to defer to), `resolveSecretEnv` genuinely resolves the
value itself before spawning.

`OPENAPI_MCP_HEADERS: ${NOTION_OPENAPI_MCP_HEADERS}` is the same kind of
reference, just under a *different* target key than the source
variable's own name. `mcpMigrateRead.ts`'s `SELF_VAR_REF_RE` match
requires `match[1] === key`, so this case falls through into
`staticEnv` — which every renderer, including pi-bridge, correctly (by
its own existing contract) treats as an inert literal. The literal
placeholder text ends up as notion's actual env value on pi, and
notion's own `JSON.parse` of it throws. Confirmed live: codex's copy of
the exact same broken canonical value still shows "connected" in a real
`/mcp` session — real evidence codex's own TOML env-table loader does
its own `${VAR}` expansion from its own ambient environment (this is
evidence, not something read out of codex's source, since codex is a
closed-source-to-this-project real binary).

## Goals / Non-Goals

**Goals:**
- Recognize `${NAME}` as a reference needing resolution regardless of
  whether `NAME` matches the target key it's declared under.
- Deliver a differently-named reference through the exact same
  mechanism each target already uses for the self-referencing case — no
  new resolution mechanism, no new native-runtime assumption beyond
  "the same one already relied on for `env`."
- pi's bridge — the one target with no native runtime to defer to —
  genuinely resolves the *source* name via `resolveSecretEnv` and
  delivers it under the *target* key.

**Non-Goals:**
- Trellis never reads, captures, or stores a real secret *value* during
  migrate-in — only the reference (which name, under which key). This
  change adds no code path that touches a real credential value at
  migrate time; only `mcp sync`/pi-bridge's existing, pre-existing
  resolution paths ever see a real value, exactly as today.
- No change to `staticEnv`'s own contract — a value that is genuinely
  literal (not `${...}`-shaped at all) is unaffected.
- No change to `headers`' existing `${VAR}` handling — it already
  supports an embedded reference to any name, this change only closes
  the same gap for `env`/`staticEnv`.

## Decisions

**D1 — New field `envAliases?: Record<string, string>` on
`McpServerDef`** (target key → source variable name), rather than
widening `env: string[]`'s own shape. Keeping `env` as a flat name list
for the (much more common) self-referencing case avoids touching every
existing reader/writer/test that already assumes "one name, delivered
under its own name" — this is strictly additive. `envAliases` is empty/
absent whenever no alias case exists, so every existing canonical
`servers.yaml` file continues to parse and round-trip unchanged.

**D2 — Read-path: recognize `${NAME}` for ANY name, route to `env` when
self-referencing (unchanged) or `envAliases` when not.**
`mcpMigrateRead.ts`'s classification becomes: value matches
`^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$` → it's a reference; `match[1] ===
key` → append to `env` (today's behavior, unchanged); otherwise → set
`envAliases[key] = match[1]`. Anything not matching the regex at all
remains a literal in `staticEnv`, exactly as today.

**D3 — Write-path: claude-code/kiro/codex render `envAliases` through
the exact same literal-placeholder mechanism already used for `env`'s
self-referencing case**, just with the source name in the placeholder
instead of the key: `renderJsonServerEntry` adds
`{ [targetKey]: "${sourceName}" }` into the same merged `env` object (no
separate object, same discipline `staticEnv` already merges into);
`renderServerSection` writes `envAliases` entries into the *same*
`[mcp_servers.<name>.env]` literal table `staticEnv` already uses (both
are literal-table entries from Codex's own perspective — the only
difference is Trellis's own bookkeeping of "this literal text is a
reference", not anything Codex's TOML format itself distinguishes).
This relies on the same native-runtime-expands-it assumption `env`
already relies on for codex/claude-code/kiro — not a new assumption,
the same one, now applied without the same-name restriction.

**D4 — Write-path: pi-bridge genuinely resolves `envAliases` via
`resolveSecretEnv`, keyed by source name, delivered under target key.**
`resolveSecretEnv(Object.values(def.envAliases ?? {}), policy)` resolves
every source name once; the bridge then builds
`{ [targetKey]: resolved[sourceName] }` for each alias entry and merges
it in at the same point `env`'s own resolved names are merged — before
`staticEnv` (D4's ordering in the existing code: `staticEnv` merges
last since it's the one genuinely-literal, override-safe layer;
resolved `env`/`envAliases` values merge before that, unchanged
relative ordering).

**D5 — Unresolvable alias source blocks the write, same posture as
`env`'s existing "unresolvable env name" refusal**
(`mcp-server-sync`'s existing requirement). `envAliases` entries are
checked alongside `env` entries in the same pre-write resolution guard,
not a parallel, differently-behaved check.

## Risks / Trade-offs

- [D3 relies on codex's own `${VAR}` expansion for its literal env
  table — verified only by live observation (the real `/mcp` screenshot
  showing "connected"), not by reading codex's own source, since it's a
  closed binary to this project] → if a future codex version changes
  this behavior, the alias case would silently break for codex the same
  way the un-fixed bug already silently broke pi — no new risk
  introduced beyond what `env`'s self-referencing case already carries
  today for the exact same reason.
- [`envAliases` is a second field alongside `env`/`staticEnv` — three
  env-shaped fields to keep straight] → mitigated by keeping the
  semantics maximally narrow: `envAliases` exists *only* for the
  differently-named case; the common, same-named case still always uses
  `env`, never `envAliases` — so `envAliases` stays rare in practice,
  not a parallel general-purpose mechanism competing with `env`.

## Migration Plan

No stored-data migration needed — `envAliases` is a new, optional field;
existing `servers.yaml` files with no alias entries are unaffected.
Re-running `migrate --only mcp` for an agent whose real config has this
shape (like notion here) will now correctly populate `envAliases`
instead of the broken `staticEnv` entry; the broken existing canonical
`servers.yaml` entry for notion on this real machine needs one manual
re-migrate (or hand-edit) after this ships — called out in tasks.md, not
silently auto-fixed by this change itself.
