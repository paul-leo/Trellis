## Context

Four real, verified schemas (CLI `--help`, real installed extension
source, real SDK `.d.ts` — proposal.md's Why section has the specifics)
converge on: a plain `Record<string,string>` headers map works for
Claude Code, Kiro, and the pi bridge; Codex has no generic headers
concept at all, only a single purpose-built `bearer_token_env_var`
field. Real OAuth (browser redirect, token storage/refresh) is already
native to Claude Code, Codex, and Kiro — pi has none and gains none
here.

A header value is a `${VAR}` reference exactly like `env` — which means
every place that currently extracts "what var names does this file/def
declare" (P3's `secrets audit`, P8's Kiro approved-env-vars) has a new
place to look, or it silently misses exactly the class of thing those
two features exist to catch. Shipping `headers` without teaching both of
them about it would reproduce P8's own root cause (a new secret-carrying
field the audit/approval logic doesn't know exists) for a different
field. This change ships both together, not the field alone.

## Goals / Non-Goals

**Goals**
- Static header-based auth (bearer token, API key header) expressible
  for Claude Code, Kiro, and pi via one canonical `headers` field.
- Codex gets the one shape it can actually express
  (`bearer_token_env_var`), and a real, reported conflict — never a
  silent drop or a lossy approximation — for anything else.
- `secrets audit`'s `unexpected-var-name` check and the `missing-env-value`
  check (trellis-secrets-env-management) both see header-embedded names,
  not just `env` keys.
- Kiro's approved-env-vars list (trellis-kiro-approved-env-vars) covers
  header-embedded names too — Kiro's own substitution recurses into
  `headers` the same as `env` (verified against its real source).

**Non-Goals**
- No OAuth implementation anywhere in this change.
- No generic multi-header support for Codex.
- No new schema field for OAuth config passthrough (Kiro's real `oauth`/
  `oauthScopes` fields exist in its schema but wiring `mcp/servers.yaml`
  to populate them would be scaffolding for a flow this project
  explicitly isn't building — left as an open question, not solved.

## Decisions

### D1 — `headers?: Record<string, string>` on `McpServerDef`, values are `${VAR}` references

Same secrets discipline as `env`: Trellis never holds a real value, only
names inside `${...}` template strings. Meaningful only when
`transport` is `"http"` or `"sse"`.

### D2 — `Transport` gains `"sse"`; the dead `auth` field is removed

`auth?: "oauth" | "bearer-env"` was never read anywhere (confirmed by a
full-repo grep) — a stub from an earlier design pass that predates this
project's actual per-agent schema verification. `"bearer-env"` is what
`headers` now expresses properly (a value referencing an env var);
`"oauth"` never had an implementation to speak for, and adding one is a
Non-Goal. Removing rather than keeping it dead: a field that looks
load-bearing but isn't is worse than no field.

### D3 — Claude Code / Kiro: `headers` passed through verbatim, same shape

Both `renderJsonServerEntry` (Claude Code, Kiro share this function via
`jsonMcp.ts`) already just spread through the def's fields for the
`http` branch (`{type: "http", url}`); adding `headers: def.headers`
when present is a one-line change per real, verified schema
compatibility — no per-agent branching needed here, unlike Codex.

### D4 — Codex: `bearer_token_env_var` when expressible, a conflict when not

`renderServerSection` (`tomlSection.ts`) recognizes exactly one shape:
`headers` is exactly `{ Authorization: "Bearer ${VAR}" }` (one key,
exact prefix, one referenced name) → renders
`bearer_token_env_var = "VAR"`, matching what Codex's own official CLI
generates. Any other shape (multiple headers, a non-`Authorization` key,
a value not matching `Bearer ${VAR}` exactly) is **not silently dropped
or approximated** — `resolveMcpPlan`'s Codex-specific branch (already
has one precedent: the `known_host_injected` collision message already
carries extra Codex-only text) produces a `"conflict"` item naming the
server and explaining Codex's real limitation. The other three agents
are unaffected — a Codex-only conflict never blocks Claude Code/Kiro/pi
from getting the same server's full `headers` map.

### D5 — pi bridge: `requestInit.headers` on `connectHttp` and a new `connectSse`

`connectHttp` already exists (P4); add `requestInit: { headers: resolved }`
using the same `resolveSecretEnv` (trellis-secrets-env-management) the
stdio path already uses — headers need secret resolution exactly like
`env` does. A new `connectSse` mirrors it via `SSEClientTransport`
(same SDK, confirmed to accept the identical `requestInit`/`authProvider`
shape). `def.transport === "sse"` routes here instead of `connectHttp`.

### D6 — Secrets audit and Kiro's approval list both learn to look inside `headers`

New shared helper, `src/lib/envVarNames.ts`'s `extractTemplateVarNames(value)`:
parses every `${NAME}` occurrence out of a string (a header value can in
principle reference more than one name, e.g. a compound header —
handled the same way `env`'s single-name-per-value case already is,
just generalized).

- `extractJsonEnvVarNames` (P3, reads real Claude Code/Kiro config files):
  also scans each server's `headers` object *values* (not keys, unlike
  `env`) through `extractTemplateVarNames`.
- `extractTomlEnvVarNames` (P3, reads real Codex config): also matches a
  `bearer_token_env_var = "VAR"` line (a bare name, like `env_vars`, not
  a `${VAR}` template — Codex's own field holds a name directly).
- A new canonical-side helper, `declaredEnvNames(def: McpServerDef)`
  (`env` names ∪ names extracted from `headers` values), used by both
  `findMissingEnvValues` (secretsAudit.ts) and `KiroAdapter`'s
  `desiredApprovedEnvVars` — replacing their current `def.env ?? []`-only
  collection, so both features see exactly the same "what names does
  this def actually reference" answer headers included.

## Risks / Trade-offs

- Codex's single-bearer-token limitation means the "same server, same
  canonical definition" story breaks down for anything beyond one bearer
  header — a real, disclosed gap, not a silent one. A server needing
  multiple custom headers simply can't reach Codex through Trellis;
  it can still reach the other three.
- `extractTemplateVarNames` allowing multiple names per value is
  currently unexercised by any real header shape this change ships
  (Codex's own bearer-token check requires exactly one) — kept general
  for `env` audit parity, not overfit to Codex's narrower need.

## Migration Plan

Fully additive: `headers` and `"sse"` are new optional/enum-extending
fields; a canonical source with neither behaves identically to before
this change. Removing the dead `auth` field is a type-level breaking
change only for anyone who imported `McpServerDef` from the SDK barrel
(`trellis-sdk`) and referenced `.auth` directly — grep confirms nothing
in this repo does; documented in the commit message as a heads-up for
any external consumer of `agent-trellis`'s exported types.

## Open Questions

- Should `mcp/servers.yaml` eventually gain a way to pass through Kiro's
  real `oauth`/`oauthScopes` fields verbatim (not implement OAuth, just
  let Trellis carry the config through to the one agent whose native
  flow would then pick it up)? Left open — no evidence yet that anyone
  needs this before building it.
- Should `trellis doctor` warn when a server declares `headers` but the
  present agent set includes Codex and the header shape isn't
  bearer-token-expressible, *before* a sync attempt, rather than only
  surfacing it as a conflict during `mcp sync`? Left for a future change.
