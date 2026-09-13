## Context

`trellis migrate` already imports skills and instructions; MCP servers
were deliberately left out of both P11 (initial migrate) and P14 (which
added MCP *removal*, explicitly naming migrate-in as a separate, real
gap). Each static-config probe already parses a server's full real
definition but discards it down to `AgentSnapshotMcpServer`'s thin
`{name, transport, probe?}` shape — that shape exists purely for
`doctor`'s drift-reporting and is not a source this change should read
from or extend; migrate-in needs its own, richer read path.

Two fidelity gaps were found by reading each agent's actual real output
shape (not assumed) before writing this design:

1. **Codex**: `CodexMcpEntry` (`src/probes/codex.ts`, fed by `codex mcp
   list --json`) only ever declares `{type, command, args, env_vars}` —
   no `url`, no `bearer_token_env_var`. This isn't a gap in Trellis's
   parsing; Codex's own `mcp list --json` output for this codebase has
   never been read for anything beyond stdio-shaped entries. Separately,
   `renderServerSection` (`src/lib/tomlSection.ts`) confirms `static_env`
   values live in a second, adjacent `[mcp_servers.<name>.env]` TOML
   table — `env_vars` in the main table is names only. Neither gap can
   be closed by better JSON parsing; both require either accepting
   reduced fidelity or reading the TOML file directly for the one piece
   the subprocess can't report.
2. **claude-code / kiro**: both probes' own JSON server-def types
   (`ClaudeJsonServerDef`, `KiroMcpServerDef`) have `{type?, command?,
   args?, url?, env?}` — no `headers`, confirmed absent from both via
   `grep -n "headers" src/probes/kiro.ts src/probes/claude-code.ts
   src/adapters/jsonMcp.ts`, which shows `headers` used only in the
   writer (`jsonMcp.ts`'s `renderJsonServerEntry`). Both probes
   currently parse-then-drop this field for every purpose, not just
   migrate-in.

## Goals / Non-Goals

**Goals:**
- Read claude-code's, kiro's, and codex's real, already-configured MCP
  servers and convert each into canonical's `McpServerDef` shape.
- Preserve the exact same conflict posture as skill/instructions
  migration: identical content is a no-op, differing content by the
  same name is a conflict (reported, never overwritten), a brand-new
  name is created.
- Name, rather than silently drop or guess at, anything that can't be
  safely represented (Codex non-stdio transport).

**Non-Goals:**
- pi migrate-in — pi has no static config file to read at all (already
  established fact, re-confirmed here, not re-litigated).
- Recovering Codex's `static_env` for a *non-stdio* server, or any
  http/sse field for Codex at all — genuinely unverified real-world
  shape (`codex mcp list --json` has never been observed against such a
  server in this codebase); guessing at an unverified external tool's
  output shape is exactly the kind of assumption this project's
  "verify, don't assume" discipline exists to prevent.
- Any change to `doctor`'s existing `AgentSnapshotMcpServer` shape or
  either probe's existing, tested type — the new, richer type is
  additive and lives in its own module.
- Any change to `mcp sync`'s existing create/repair/remove behavior —
  this is a read path into canonical, entirely separate from
  `mcp sync`'s canonical-to-agent write path.

## Decisions

**D1 — New module `src/lib/mcpMigrateRead.ts`, not an extension of
`src/probes/*.ts`.** Each probe's existing type stays exactly as-is;
this module defines its own richer per-format read-side types
(`ClaudeCodeMcpEntryRich`, `KiroMcpEntryRich`) with `headers` added,
and reads the same on-disk file a second time with its own parse. Costs
one extra file read per migrate run — negligible, and it means zero
risk to `doctor`'s already-extensive test suite. Matches this project's
own established precedent (`AgentSnapshotMcpServer`'s own design notes
already describe deliberately using a parallel, narrower type rather
than reusing a richer one for a different purpose — same reasoning
applied in reverse here).

**D2 — Codex migrate-in is stdio-only; a non-stdio entry becomes
`skip-unsupported`, never a guess.** `codex mcp list --json`'s
`CodexMcpEntry.transport.type` is checked; anything other than
`"stdio"` produces a plan item with the new `"skip-unsupported"`
action and a message naming the reason, rather than attempting to
reconstruct a `url`/`headers` shape this codebase has no evidence for.

*Addendum, found while implementing:* running `codex mcp list --json`
against a real, locally-installed `codex-cli 0.154.0` with a hand-written
`url`-based server did produce real output —
`transport: {type: "streamable_http", url, bearer_token_env_var,
http_headers, env_http_headers, http_headers_helper}` — so evidence now
exists for *this one version*. Scope is intentionally NOT expanded to
cover this mid-implementation: one data point from one version, on one
machine, isn't enough to commit to a stable contract (the string is
`"streamable_http"`, not codex's own probe's `"http"`; three of those five
fields are unexplained here), and doing so would bypass this project's
own propose→design→specs→tasks discipline for a scope change. Recorded
here as a concrete lead for whoever picks up Codex http/sse migrate-in
next, not as a decision to build it now.

**D3 — Codex's `static_env` is recovered by reading `config.toml`
directly, not by extending the subprocess call.** A new function,
`readServerEnvTable(content, name): Record<string,string> | undefined`
in `src/lib/tomlSection.ts`, locates `[mcp_servers.<name>.env]` via the
existing `findSection` (already used by `findServerRange`) and parses
each `key = "value"` line — the same bounded, known-shape templating
this module already does for writing, applied to reading. This is safe
because Codex's own two-part TOML structure is entirely Trellis's own
prior design decision (`renderServerSection`), not an assumption about
Codex's behavior — reading it back is just the inverse of a shape this
codebase already writes and controls.

**D4 — `MigratePlanItem` gains `mcpDef?: McpServerDef`, not a new
plan-item type.** Keeps `collectMigratePlan`'s existing
kind-dispatch/`wants()` gating pattern (already used for
skill/instructions) rather than introducing a parallel data structure
just for MCP — `applyMigratePlan`'s MCP branch reads `item.mcpDef` the
same way it already reads `item.sourceDir`/`item.sourceContent`.

**D5 — Conflict comparison is against canonical's already-loaded
`McpConfig.servers`, not a second YAML parse.** `collectMigratePlan`
already has `homeDir`; it loads canonical's current servers via the
same `loadCanonicalSource`-adjacent path `mcp.ts`'s own commands use,
and does a structural `deepEqual` against any existing same-named
entry — matching P14's own established equality convention for JSON
comers reused here for the migrate-in comparison, not reinvented.

**D6 — Write path reuses `upsertServerYaml` from `canonical.ts`
unchanged.** Built in P12, already comment-preserving and tested;
`applyMigratePlan`'s MCP branch calls it once per `"create"` item,
exactly the same reuse principle as D6 in the P14 change (reuse an
existing, working primitive rather than hand-rolling a second write
path).

## Risks / Trade-offs

- **[Risk] A user reasonably expects Codex http/sse servers to migrate
  too, and `skip-unsupported` reads as "broken."** → Mitigation: the
  message names the exact reason (transport not yet supported for
  Codex migrate-in) and points at `mcp add` as the immediate workaround
  for that one server — same posture as `migrate`'s existing
  `skip-symlink`/`skip-case-broken` actions, which already communicate
  "known, named, not silently lost" rather than "error."
- **[Risk] `headers` recovery for claude-code/kiro could diverge from
  `jsonMcp.ts`'s own writer if either drifts later.** → Mitigation:
  both sides read/write the identical on-disk field name (`headers`,
  `Record<string,string>`) with no transformation in between; a test
  asserts a round-trip (write via `jsonMcp.ts`, migrate-in read via the
  new module, byte-for-byte identical `McpServerDef.headers`).

## Migration Plan

No data migration — this is a new read path with no schema change to
any file already on disk. Rollout is a single change, gated by the
existing test suite; no feature flag needed (matches every other
change in this project's history — `trellis migrate` has never been
gated behind a flag).

## Open Questions

None outstanding — both fidelity gaps have a decided scope (D2/D3), and
pi's exclusion is an already-established fact, not a new open question.
