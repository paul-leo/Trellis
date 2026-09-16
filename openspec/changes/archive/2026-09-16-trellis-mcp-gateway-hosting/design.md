## Context

Trellis currently has two working, independently-verified pieces that
are relevant here but have never been combined: `src/pi-bridge/index.ts`
(a real MCP client aggregator, tested in production for pi) and, from
this change's own research spike, a hand-verified-correct OAuth
discovery/PKCE/DCR/refresh implementation pattern (`@pcandido/mcphub`,
excluded as a dependency in proposal.md but not as a design). This
document's job is to combine them into a standard MCP `Server` that
claude-code/codex/kiro can spawn as an ordinary stdio subprocess, with no
daemon, no Docker, and no plaintext secrets at rest.

The confirmed long-term direction is that all agents share **one**
running service rather than each getting its own connection set. v1 does
not build that service, but it is not free to ignore it either: v1's job
is to put the decoupling seam in the right place so the shared service
can be added later as a pure addition, with the per-session process
degrading into a thin client of it and no agent's config changing.

## Goals / Non-Goals

**Goals:**
- One native stdio MCP entry per agent, replacing N per-server entries,
  when gateway mode is enabled.
- Zero plaintext secrets anywhere in the gateway's own code path — same
  guarantee `resolveSecretEnv` already gives the direct-write path.
- No daemon, no lifecycle command, no process the user has to think
  about — spawned by the agent, exits with the agent's session.
- A backend seam (D11) such that converging every agent onto one shared
  service later requires no change to any agent's native config, and no
  rewrite of the aggregation, secret, or OAuth logic.
- Correct, tested OAuth for remote servers that need it, with first-time
  authorization requiring one explicit, human-run command.

**Non-Goals (v1):**
- A gateway-hosted HTTP or SSE transport (agents only ever see stdio).
- Any gateway lifecycle management command (`start`/`stop`/`status`).
- Any GUI, dashboard, or account system.
- The shared service itself: sharing one set of upstream connections
  across concurrently-running agents is deferred to v2 (D11/D12). v1
  ships the seam and the correctness fix that would otherwise make
  concurrency unsafe (D16's refresh lock), not the service.

## Decisions

**D1 — Build, don't adopt a third-party gateway package.** Restated with
more detail than proposal.md: MetaMCP requires Docker (hard constraint
violated), mcp-local-hub's macOS support is roadmap-only (target platform
unsupported today), `@samanhappy/mcphub` is a full authenticated web
product with 43+ dependencies and no importable SDK surface (`exports`/
`types` absent from `package.json`) — adopting it would mean either
running a product Trellis doesn't need or forking something never
designed to be embedded. `@pcandido/mcphub` is architecturally the right
shape (zero deps, stdio-first, no UI) and its OAuth implementation is
provably correct by direct testing, but its `env` field has zero `${VAR}`
expansion — a direct conflict with Trellis's core secrets discipline that
cannot be patched around without forking it anyway. Once forking is on
the table, building directly on `pi-bridge`'s already-proven connect
logic is less total work than forking and adapting someone else's stdio
transport layer to Trellis's secret model.

**D2 — The agent-facing exposure shape is "one stdio subprocess per
agent session, spawned on demand," permanently; whether that subprocess
does the upstream work itself is a separate, swappable question.** An
agent's own stdio MCP client spawns `trellis mcp-gateway`, talks to it
over stdin/stdout for the session, and the process goes away when the
session ends — the same lifecycle every other stdio MCP server already
has under Claude Code/Codex/Kiro, so there is never a start/stop/status
command and nothing for the user to notice.

This is deliberately *only* a statement about the agent-facing edge. It
holds in v1 (where that subprocess connects upstream itself) and equally
in v2 (where it forwards to a shared service, D11/D12). Fixing the edge
shape now is what lets the interior change later without re-syncing a
single agent config — the entry those agents hold is the same string in
both worlds.

**D3 — Extract `pi-bridge`'s connect logic into a shared module instead
of reimplementing it for the gateway.** `connectStdio`/`connectHttp`/
`connectSse`/`withTimeout`/`connectWithCleanup`/`resolveHeaders` in
`src/pi-bridge/index.ts` already carry real bug-fix history (the leaked
child-process-on-timeout fix, the envAliases literal-placeholder fix) —
duplicating this logic into a second file means every future fix to one
has to be remembered and re-applied to the other, which is exactly the
kind of drift this project's own ownership-ledger and ownership-marker
patterns exist to avoid elsewhere. `src/lib/mcpConnect.ts` becomes the
one place this logic lives; both `pi-bridge/index.ts` and the new
`mcpGateway.ts` command import it.

**D4 — Use `@modelcontextprotocol/sdk`'s `Server` + `StdioServerTransport`
for the gateway's own outward-facing protocol, not a hand-rolled
JSON-RPC loop.** The `Client` half of this same SDK is already relied on
by `pi-bridge` in production; the `Server` half is the same package, same
version, same trust level, and correctly implements `initialize`/
`tools/list`/`tools/call` framing so Trellis doesn't have to maintain a
second, hand-written implementation of the MCP wire protocol. Zero new
dependency.

**D5 — The new canonical field is independent of, not a redefinition of,
`hub`.** `hub` means "a URL to an HTTP MCP endpoint the user operates
separately" (`HubConfig { url: string }` in `src/core/types.ts`) — an
adapter that sees `hub` set writes one static URL entry and never spawns
anything. The new gateway field means "run a local stdio process Trellis
itself owns." Overloading `hub` to also mean this would force every
future reader of that field to disambiguate two unrelated concepts by
context; a second, orthogonal field keeps both legible and lets a user
theoretically point some agents at an externally-hosted hub while others
converge through the local gateway, without either code path needing to
know the other exists.

Its shape is `GatewayConfig { enabled: boolean; agents?: AgentId[] }`.
`enabled` on its own turns gateway mode on for every managed agent, and
that is the intended normal use — which agents converge is not a
question a user should have to answer to get the feature. The optional
`agents` list exists because the alternative, a bare boolean, would
delete a real capability rather than simplify one: the hub/gateway
coexistence this very decision argues for is only observable if the two
can be pointed at different agents, and the mixed-mode scenarios in
spec.md depend on it. Three lines of scope check buys that back, so the
narrowing stays available and unused by default.

**D6 — `resolveMcpPlan`'s gateway branch is checked before the `hub`
branch, and the two are mutually exclusive per resolution, matching the
existing hub branch's own early-return shape.** If both `mcp.hub` and the
new gateway field were set simultaneously, only one desired entry can
exist per agent (a stdio gateway entry and an HTTP hub entry cannot both
be "the one MCP entry" for the same agent without ambiguity about which
tools route where) — the gateway branch takes precedence because it is
the newer, purpose-built path for the constraint this change exists to
solve (Docker-free, invisible-to-the-user local convergence), while `hub`
remains available unchanged for anyone still using an externally-operated
endpoint. Every other server-level check (`enabled: false`, per-server
`agents:` scope, `known_host_injected`, literal-secret guard, unresolved
`env` name) still runs against the underlying `mcp.servers` set at
gateway-*startup* time, inside the gateway subcommand itself — not
inside `resolveMcpPlan`, since the adapters no longer see individual
servers at all in gateway mode.

**D7 — Reuse `AdapterPlanItem`'s existing `kind: "mcp"`, no new kind.**
From an adapter's `apply()` perspective, gateway mode is still "write one
MCP server definition into the native config" — only the definition's
own shape changes (a `command` pointing at `trellis mcp-gateway` instead
of a real upstream command/URL). Introducing a new `kind` would require
every adapter's plan-item switch to grow a redundant branch that does
exactly what the existing `"mcp"` branch already does.

**D8 — OAuth token storage lives at `~/.trellis/mcp/oauth/<name>.json`,
one file per server, mode 0600 — not inside `servers.yaml`, not through
`resolveSecretEnv`, not the OS Keychain.** A token is a runtime credential
the gateway itself obtains and refreshes, not a name the user declares
and points at an external secret source — `resolveSecretEnv`'s whole
contract is "resolve a name the user wrote in canonical," which doesn't
fit a value Trellis generates and rotates on its own. This is
Trellis-owned bookkeeping, the same category as `~/.trellis/backups/`,
so it lives next to it under `~/.trellis/`. The OS Keychain is
deliberately not used: this change's own research spike reproduced
`security add-generic-password` failing (exit 152/154) in a
non-interactive shell with no GUI session — exactly the environment an
agent-spawned gateway subprocess runs in.

**D9 — The gateway subcommand never opens a browser; only `trellis mcp
auth <name>` does.** The gateway is spawned silently by an agent as a
stdio subprocess and typically has no attached interactive terminal or
display — it cannot reliably prompt a human or receive a browser
redirect. A `refresh_token` grant needs neither of those and can run
silently inside the gateway whenever it detects an expired token. The
initial authorization-code exchange needs a real browser and a local
callback listener, which only makes sense as an explicit, user-invoked,
one-time command.

**D10 — v1 scope excludes: a gateway-native HTTP/SSE transport (agents
only ever get stdio), any daemon lifecycle command, and any GUI.** Each
would either reintroduce a resident process the user has to be aware of,
or add surface area (a dashboard, an account system) this change's whole
premise is to avoid — the same reasoning that excluded
`@samanhappy/mcphub` in the first place.

**D11 — The seam is a `GatewayBackend` interface, and it is the only
thing `mcpGateway.ts` is allowed to talk to.** `src/lib/gatewayBackend.ts`
declares roughly `{ listTools(): Promise<Tool[]>; callTool(name, args):
Promise<CallToolResult>; close(): Promise<void> }`. v1 ships one
implementation, `LocalBackend`, which owns the `mcpConnect` +
`mcpToolRegistry` pair and connects upstreams in-process. v2 adds a
second, `RemoteBackend`, which forwards the same three calls to the
shared service. `mcpGateway.ts` itself — the MCP `Server` over
`StdioServerTransport` that the agent actually talks to — never
references a connection, a transport, or a server definition; it
constructs a backend and delegates. Swapping v1 for v2 is one
construction site, not a rewrite, and by D2 the agent never notices.

The shared service, when it arrives, is then not new machinery either:
it is the same MCP `Server` class wrapping the same `LocalBackend`, with
a socket transport instead of a stdio one. That symmetry is the whole
reason to put the seam here rather than lower down.

**D12 — The RPC between a future thin client and the shared service is
MCP itself, over a Unix domain socket — not a bespoke protocol.** The
SDK's wire format on stdio is newline-delimited JSON-RPC, and its
framing helpers are importable directly (`ReadBuffer`,
`serializeMessage` from `@modelcontextprotocol/sdk/shared/stdio.js` —
verified importable at v1.30.0 via the package's `./*` export). A
`Transport` implementation over a `net.Socket` is therefore the same
framing against a different stream, and both `Client` and `Server`
accept any `Transport`. Consequences worth stating: zero new
dependencies, zero new protocol to specify or version, `RemoteBackend`
is a thin wrapper over a standard `Client`, and a socket path
(`~/.trellis/mcp/gateway.sock`) needs no port allocation, no loopback
binding, and gets filesystem permissions for free. Deliberately not
chosen: HTTP/SSE on a loopback port (needs port discovery and a
listening socket any local process can reach) and a hand-rolled length-
prefixed protocol (a second wire format to own, for no gain).

**D13 — The gateway must shut itself down on stdin EOF, explicitly;
the SDK will not do it.** `StdioServerTransport.start()` registers
listeners for `'data'` and `'error'` only — there is no `'end'` or
`'close'` handler, so when the agent exits and the pipe's write end
closes, the transport never fires `onclose`. Meanwhile POSIX does not
kill orphans: the process is re-parented to launchd and keeps running,
and its own event loop is held open by every upstream stdio child and
socket it opened. Left alone, the result is that **every agent session
permanently leaks a gateway plus its entire upstream set** — the same
class of bug `src/pi-bridge/index.ts:77` documents catching in its own
test run, one level up. The gateway therefore listens on `'end'` itself,
closes every upstream client, kills every upstream child process, and
exits. SIGHUP/SIGTERM/SIGINT route to the same teardown. This is not an
optimization; without it the "no process the user has to think about"
promise in D2 is false.

**D14 — The shared service is one process, but the tool view stays
per-agent; the agent id travels as an argument, not as a separate
process.** Per-server `agents:` scoping already exists in
`McpServerDef` and there is no reason for gateway mode to silently
discard it — a server the user scoped to `agents: [codex]` becoming
visible to claude-code would be a real semantic regression, not a
simplification. So each agent's native entry is `trellis mcp-gateway
--agent <id>`, and that id selects which upstreams' tools appear in
`tools/list` for that connection. In v1 it also selects which upstreams
that process connects to at all. In v2 the shared service holds one
connection per upstream regardless, and filters the *view* per connected
client. "Not per-agent" is thus true of the process and of the
connection set, and deliberately not true of the visible tool set.

**D15 — The gateway's own entry name gets the same collision check
`hub` already has.** `resolveMcpPlan`'s hub branch refuses to write
`trellis-hub` when that name appears in `mcp.knownHostInjected`
(`src/adapters/mcpPlan.ts:99-101`), reporting a conflict instead of
silently shadowing an agent-injected server. The gateway branch gets the
identical guard against its own constant. P0's real finding on this
machine — a `sentry` name statically configured *and* host-injected —
is exactly the case this catches.

**D16 — Concurrent OAuth refresh is serialized by a lock file,
independent of how many gateway processes exist.** Most authorization
servers rotate the refresh token on each `refresh_token` grant and
invalidate the previous one, so two processes refreshing the same
server's token concurrently leave one of them holding a dead refresh
token — a silent correctness bug, not a performance one. This is
reachable today even with a single gateway, because `trellis mcp auth`
can be run by hand while a gateway is live, and it stays reachable in
v2 for the same reason. The refresh path therefore takes an exclusive
lock on `~/.trellis/mcp/oauth/<server-name>.lock` and re-reads the token
file after acquiring it (the holder may have just refreshed it, in which
case there is nothing to do). This is required in v1 — it is what makes
v1's multi-process reality safe while the shared service does not yet
exist.

## Risks / Trade-offs

- [Building the gateway in-house instead of adopting a package] → Trellis
  now owns long-term maintenance of tracking MCP protocol/spec changes
  itself, rather than inheriting that work from an upstream maintainer.
  Mitigated by D4 (the SDK, not Trellis, owns wire-protocol correctness)
  but not eliminated — aggregation/prefixing/OAuth logic is still ours.
- [OAuth is security-sensitive code] → needs test coverage at least as
  thorough as the hand-built fake-Authorization-Server spike that
  validated `@pcandido/mcphub`'s design (discovery, PKCE, DCR, token
  persistence, refresh), not just happy-path unit tests.
- [v1 runs N gateway processes when N agents are open concurrently] →
  N×M upstream connections, and each session pays its own connect
  latency. Accepted for v1: the one consequence that is a *correctness*
  problem rather than waste is concurrent OAuth refresh, and D16 fixes
  that directly. The rest is what D11/D12's seam exists to retire.
- [Designing v2's seam before building v2] → the `GatewayBackend`
  interface could turn out to be cut in the wrong place once a real
  shared service is written. Mitigated by keeping it to three methods
  that mirror the MCP operations the agent itself issues, so a mismatch
  would have to be a mismatch with MCP's own shape; and by D12, which
  makes `RemoteBackend` a standard `Client` rather than something whose
  requirements could drift.
- [A shared service introduces version skew] → a long-lived service
  started by an older Trellis keeps serving after an upgrade, while new
  thin clients connect to it. Not a v1 risk (no service exists), but the
  seam should not make it harder to solve later; a version field in the
  socket handshake plus a mismatched-version service exiting on idle is
  the expected answer, to be specified with v2.

## Migration Plan

Purely additive: the new canonical field defaults to unset/off, in which
case `resolveMcpPlan` behaves exactly as it does today (D6's branch never
triggers). No existing agent config, server definition, or command
changes behavior until a user explicitly opts a server or agent set into
gateway mode.

## Open Questions

Resolved since the first draft: "should upstream connections be shared
across invocations" is no longer open — they should, that is the
confirmed direction, and D11/D12 fix where the seam goes. What remains
open is the shared service's own lifecycle, all of it deferred to v2:

- Who starts the service, and how is the start race resolved when two
  agents launch at the same moment and both find no socket? (Expected:
  `detached: true` + `unref()` behind an exclusive lock on a
  sibling `.lock` file, with the loser retrying the connect.)
- When does it stop? (Expected: idle timeout after the last client
  disconnects, so it stays invisible per D2 — but the timeout value, and
  whether a still-warm upstream should extend it, are unexamined.)
- How is a stale socket file — left by a killed service — distinguished
  from a live one? (Expected: connect-and-fail is the probe, then
  unlink; needs care not to unlink a socket a concurrent starter just
  created.)
- Version skew handling, per the last entry under Risks.

These are listed to be answered *when v2 is scoped*, not now. v1 is
complete and useful without any of them, which is the point of D11.
