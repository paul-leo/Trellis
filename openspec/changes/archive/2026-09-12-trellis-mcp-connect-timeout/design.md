## Context

Reproduced live, not synthesized: `npx @harness-fe/cli mcp` behaves
completely differently depending on whether its stdin is a readable
pipe. With `stdio: ["ignore", ...]` it prints a one-line status message
and exits `0` in under a second. With a real pipe attached and *any*
bytes written to it (a standard MCP `initialize` request, exactly what
`StdioClientTransport` sends) it produces zero bytes on stdout or
stderr and never exits, for at least 20 seconds observed. This is
indistinguishable, from the bridge's side, from "still working on
startup" — there is no signal to tell a slow-but-eventually-correct
server apart from a permanently-silent one, which is exactly why a
timeout (not a smarter heuristic) is the right fix.

The bridge's own `try/catch` around `connect()` was written (P4) with
the *rejecting* case in mind — a process that exits non-zero, refuses a
connection, or sends a malformed response. A process that neither
resolves nor rejects the SDK's `connect()` promise was never
considered, and nothing in P4's spec or tests exercised it — the
existing test suite's fake servers all either succeed or exit/error
promptly.

## Goals / Non-Goals

**Goals**
- A single hanging (or hanging-during-`tools/list`) MCP server can never
  prevent the bridge extension's load function from resolving, and can
  never prevent any other configured server from connecting and
  registering its tools.
- The existing "one bad server doesn't affect others" guarantee,
  previously only an informal code comment, becomes a spec Requirement
  with real scenarios (including the hang case, which the prior spec
  never named).

**Non-Goals**
- No retry/backoff. One timed-out attempt per `trellis sync`/pi-startup
  cycle is enough; the failure is logged the same way a `connect()`
  rejection already is.
- No attempt to distinguish "slow" from "permanently silent" beyond a
  fixed timeout — there is no reliable signal to do better with a
  stdio transport that produces no output at all.
- No change to how Claude Code, Codex, or Kiro connect to MCP servers —
  each is a separate, closed-source MCP client process; Trellis has no
  code running inside any of them to bound.

## Decisions

### D1 — A fixed timeout races `client.connect()`, per server, inside the pi bridge only

`Promise.race([client.connect(transport), timeoutRejection(ms)])`
around each of `connectStdio`/`connectHttp`/`connectSse`'s existing
`await client.connect(...)` call. On timeout, the promise this produces
rejects, which the caller (`trellisMcpBridge`'s existing `try/catch`,
unchanged) already treats identically to a real `connect()` rejection —
log, skip, move on. No new control-flow shape, just a bounded input to
the one that already exists.

Default: 10 seconds — the same constant `src/lib/mcpProbe.ts` (P0's
`doctor --probe-mcp` handshake) already uses for an equivalent bound on
an equivalent operation, confirmed by reading that file rather than
assumed. Chosen from the observed case (still silent at 20s) with
margin below it; a stdio process's own cold-start time (module
resolution, `npx` package fetch) is the dominant, highly variable
factor, and 10s is enough for every server in this project's own test
fixtures and sandbox runs, none of which do network I/O before
responding.

### D2 — `listTools()` gets the same timeout, not a separate one

A server that answers `initialize` correctly but then hangs on
`tools/list` (untested against any real server, but architecturally the
same shape of failure — a promise that never settles) gets identical
treatment: race against the same fixed timeout, timeout → log and
`closeClient`, exactly what an error thrown by `registerServerTools`
already does today. Reusing one constant rather than introducing a
second tunable — no evidence yet that the two phases need different
bounds.

### D3 — The timeout constant is not user-configurable in this change

`mcp/servers.yaml` gains no new field. A fixed value inside the bridge
is enough to convert "hangs forever" into "fails within N seconds,
loudly" — the actual goal here — without speculative configuration
surface for a need that hasn't been demonstrated. Revisit if a real
server needs longer than 10s to legitimately connect.

## Risks / Trade-offs

- A genuinely slow-but-working server (e.g. one that does real network
  I/O before its first response) that needs more than 10s will now be
  treated as failed, where before it would eventually have succeeded
  (at the cost of blocking everything else indefinitely). This is the
  intended trade: bounded failure over unbounded stall.
- The specific `@harness-fe/cli` behavior this was found against is
  not itself fixed or worked around — it will now fail fast and loud
  instead of hanging silently, which is strictly better, but it still
  won't work through the pi bridge until either the CLI's own behavior
  changes or a different (non-stdio) connection path to its shared
  gateway is confirmed viable — left as a separate, unstarted
  investigation.

## Migration Plan

Fully additive/behavioral — no schema change, no new canonical field.
A server that already connects quickly (every existing test fixture
and sandbox server) is unaffected; only a server that would previously
have hung forever now fails within the timeout instead.

## Open Questions

None outstanding — the one candidate question (whether `trellis
doctor`'s own MCP probing already handles this class of hang) is
resolved above (D1): it does, and independently arrived at the same
10s constant. No further check needed.
