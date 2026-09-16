## Why

Today Trellis's `mcp sync` writes N per-agent *native* config files (JSON
for claude-code/kiro, TOML for codex) and, for pi, a symlinked bridge
extension (`src/pi-bridge/index.ts`) — each agent resolves its own
secrets independently, at its own runtime, using its own conventions.
The user wants this collapsed into a single entry point, but with two
hard constraints that rule out most of what already exists in this
space: no Docker, and the gateway must be invisible to the user — no
daemon to start, stop, or babysit.

Three existing open-source gateways were evaluated and excluded:

**MetaMCP** ships only a Docker Compose deployment path — there is no
documented way to run it as a standalone process. Excluded: the user
does not accept Docker.

**mcp-local-hub**'s macOS support is listed as a roadmap item, not a
shipped capability — it is Windows-only today. Excluded: the target
machine is macOS.

**@samanhappy/mcphub** looked promising from its README, but unpacking
the actual package revealed a full product: a React dashboard, local
accounts backed by JWT/bcrypt, Better Auth social login, a built-in
OAuth 2.0 Authorization Server, and a TypeORM/PostgreSQL persistence
layer, pulling in 43+ dependencies. Its `package.json` has no `exports`
or `types` field — it is not something Trellis could `import` as an SDK,
only run as its own standalone product. The authentication subsystem
alone is more than an order of magnitude more surface area than this
project wants to own. Excluded after evaluation: too heavy, wrong shape.

**@pcandido/mcphub** (a different, unrelated package despite the similar
name) is the opposite: a zero-dependency, MIT-licensed, stdio-only CLI
gateway with no UI. It was tested end-to-end against the real
`@modelcontextprotocol/sdk` `Client`: stdio and SSE transport handling is
correct (`initialize`/`tools/list`/`tools/call` all round-trip, errors
come back as standard JSON-RPC error codes, and a crashed upstream
process does not take down any other upstream). To exercise its OAuth
support, a fake Authorization Server was built by hand, conforming to
RFC 8414 (metadata discovery), RFC 7591 (dynamic client registration),
and RFC 7636 (PKCE) — the resulting test drove all three metadata
discovery strategies, confirmed DCR correctly registers and then reuses
the same `client_id` on a second run, verified PKCE S256 end to end
through a real browser-driven authorization-code redirect and local
callback, persisted the resulting tokens, and — critically — forced a
token expiry and confirmed the library silently re-authenticates via the
`refresh_token` grant rather than re-running the full browser flow, then
correctly attaches the refreshed token as a Bearer header on the next
protected call. The OAuth implementation is genuinely correct.

But it has a fatal problem for this project: its stdio server `env`
field is stored and handed to the child process as a pure literal — there
is no `${VAR}` expansion mechanism anywhere in it. Writing
`"TOKEN": "${REAL_SECRET}"` into its config and inspecting what the
spawned child process actually received confirmed the literal string
`${REAL_SECRET}`, unexpanded. Its OS Keychain integration only covers
credentials for servers flagged `--oauth`; it has nothing to do with the
stdio `env` field at all. Adopting this package as-is would mean either
writing real secret values into its config in plaintext, or building a
second, parallel secret-resolution path outside `secrets audit`'s reach
— both are direct violations of Trellis's "never write a literal secret,
ever" principle. Separately, testing also showed that macOS's own
`security add-generic-password` fails (exit 152/154) in a non-interactive
shell with no GUI session to show its authorization prompt — meaning any
design that leans on the OS Keychain is not reliable in the same
automated, terminal-only contexts Trellis itself runs in. Excluded as a
dependency; its *design* is reused (see below).

## What Changes

Decision: build a small gateway inside Trellis itself, using no
third-party gateway package as a dependency, but reusing the two
architectures above that were proven correct:

1. `src/pi-bridge/index.ts` is already a production-tested
   implementation of everything a gateway needs on the "connect to N
   upstream MCP servers" side: stdio/http/sse transport handling,
   per-server connect timeouts with cleanup, tool-name prefixing and
   aggregation, and secret resolution that goes exclusively through
   Trellis's own `resolveSecretEnv`/`secrets.policy.yaml` — zero
   plaintext ever touches disk. It is currently wired to pi's
   proprietary `registerTool` API instead of a standard MCP `Server`;
   that is the only piece missing.
2. The OAuth flow (discovery, PKCE, DCR, refresh) is ported from
   `@pcandido/mcphub`'s proven-correct design — not its code — using
   Trellis's own types, with token storage moved from the OS Keychain to
   a 0600-permission JSON file (avoiding the non-interactive-shell
   failure mode found above).
3. Zero new third-party runtime dependencies: `@modelcontextprotocol/sdk`
   is already a dependency (pi-bridge uses its `Client` side; the new
   gateway uses its `Server` side).

For claude-code, codex, and kiro, enabling gateway mode means each
adapter writes exactly one native stdio MCP entry — `command` pointing at
a new internal `trellis mcp-gateway --agent <id>` subcommand — shaped
identically to any other stdio server entry those agents already
understand. Each agent spawns it on demand and it exits when the agent's
session ends: no start/stop/status commands, no daemon lifecycle to
manage, nothing for the user to notice. pi is unaffected — it keeps using
its existing bridge extension mechanism, sharing the same underlying
connect/aggregate library rather than duplicating it.

The confirmed direction beyond v1 is that every agent shares **one**
running service instead of each holding its own upstream connections.
This proposal does not build that service, but it does commit to the
seam that makes it a later addition rather than a rewrite: the stdio
subcommand talks only to a `GatewayBackend` interface, v1 implements it
in-process, and v2 implements it as a thin client forwarding over a Unix
domain socket — speaking MCP itself, so there is no second protocol to
own and no new dependency. The entry written into each agent's config is
identical in both worlds, so converging later needs no re-sync and
nothing the user has to notice.

Two things v1 must get right for that to stay true are included here
rather than deferred. First, the gateway must shut itself down when the
agent closes the pipe: the MCP SDK's `StdioServerTransport` registers no
EOF handler, and POSIX does not kill orphans, so without an explicit
teardown every agent session would permanently leak a gateway plus its
entire upstream process set. Second, OAuth refresh must be serialized by
a lock — authorization servers that rotate refresh tokens turn two
concurrent refreshes into a silently dead credential, and `trellis mcp
auth` can already race a live gateway today, before any of this is
multi-process by design.

A new `trellis mcp auth <server-name>` command handles the one piece
that genuinely requires a human: first-time OAuth authorization for a
remote server, run manually, once, by the user. The gateway subcommand
itself — spawned silently by an agent, usually with no interactive
terminal attached — never opens a browser; it only reads an
already-stored token and, if it has expired, silently refreshes it via
the `refresh_token` grant.

The canonical schema gains one new, independent, purely additive field
to express "converge this agent's MCP config into one local gateway
process." It does not reuse or redefine the existing `McpConfig.hub`
field — `hub` means "an external HTTP endpoint the user operates
elsewhere," a different concept from "a local stdio process Trellis
itself spawns." The two are orthogonal and can coexist.

## Capabilities

### New Capabilities
- `mcp-gateway-hosting`: Trellis's own stdio MCP gateway, aggregating
  every in-scope canonical MCP server behind one native config entry per
  agent, plus the first-time OAuth authorization flow a remote server
  may need.

### Modified Capabilities
- `mcp-server-sync`: claude-code/codex/kiro's `plan()`/`resolveMcpPlan`
  path gains a gateway-convergence branch, independent of and parallel
  to the existing hub branch.

## Impact

- New: `src/lib/mcpConnect.ts` (shared connect/timeout/cleanup/header
  resolution, extracted from `src/pi-bridge/index.ts`),
  `src/lib/mcpToolRegistry.ts` (aggregation/prefixing/routing, agent
  agnostic), `src/lib/gatewayBackend.ts` (the `GatewayBackend` seam plus
  v1's in-process `LocalBackend`), `src/lib/oauth/discovery.ts`,
  `src/lib/oauth/pkce.ts`, `src/lib/oauth/flow.ts`,
  `src/lib/oauth/refresh.ts`, `src/lib/oauth/store.ts`,
  `src/lib/oauth/lock.ts` (exclusive refresh lock),
  `src/commands/mcpGateway.ts` (the stdio server entry point),
  `src/commands/mcpAuth.ts` (the user-run authorization command), and
  matching `test/unit/*.test.ts` files.
- Changed: `src/pi-bridge/index.ts` (delegates to the shared connect
  module, behavior unchanged), `src/core/types.ts` (new gateway and
  OAuth-marker fields), `src/core/canonical.ts` (YAML read/write for the
  new fields, following the existing `staticEnv`/`envAliases`
  snake_case-on-disk precedent), `src/adapters/mcpPlan.ts` (gateway
  convergence branch), `src/cli.ts` (new command dispatch),
  `docs/architecture.md`, `docs/getting-started.md`, `docs/roadmap.md`,
  `schema/servers.example.yaml`.
