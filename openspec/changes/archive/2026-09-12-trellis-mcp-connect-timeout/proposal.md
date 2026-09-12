# trellis-mcp-connect-timeout

## Why

Reproduced live against a real MCP server, not hypothetical: `pi`'s
bridge (`src/pi-bridge/index.ts`) `Promise.all`s over every configured
server's `connect()` call, and each `connectStdio`/`connectHttp`/
`connectSse` awaits the MCP SDK's `client.connect()` with **no
timeout**. The existing `try/catch` per server only isolates a server
that *errors* (process exits, connection refused, protocol violation) —
it does nothing for a server whose process stays alive, produces no
stdout, and never answers the MCP `initialize` handshake. That promise
never settles, so `Promise.all` never settles, so the whole bridge's
extension-load function never resolves — which stalls every other
configured server's tools from registering too, and (per pi's own
extension-loading contract) can leave the entire `pi` process appearing
to hang.

Confirmed root cause on the machine this was found on: `npx
@harness-fe/cli mcp` exits in under a second when its stdin is not a
readable pipe, but as soon as anything spawns it with a stdin pipe (the
only way a real stdio MCP client can work) it never exits and never
writes a byte to stdout or stderr — not a network issue, not a missing
package, not a Trellis bug in the traditional sense, but exactly the
failure mode this change exists to contain.

## What Changes

- `connectStdio`/`connectHttp`/`connectSse` in the pi bridge each race
  their `client.connect()` against a timeout. On timeout, the server is
  treated exactly like a `connect()` rejection already is: logged,
  skipped, and every other server's connection/registration proceeds
  unaffected.
- The same timeout applies to `listTools()` after a successful
  connect — a server that answers `initialize` but then hangs on
  `tools/list` is an equally real failure mode and gets the same
  treatment.
- A previously-implicit guarantee (`tasks.md 3.2`'s code comment: "one
  unreachable/misconfigured server must never prevent every other
  server's tools from registering") is promoted to a real spec
  Requirement with scenarios — it existed as an assumption enforced
  only by `try/catch`, never covering the hang case, and was never
  written down as a testable contract.

## Capabilities Touched

- **MODIFIED**: `pi-mcp-bridge` (bounded connect/list-tools, explicit
  isolation guarantee).

## Non-Goals

- No fix to `@harness-fe/cli` itself, and no attempt to detect or
  route around its specific "shared gateway" behavior — that's a
  separate, unconfirmed investigation (whether `127.0.0.1:47729/mcp`
  is a real MCP HTTP endpoint) and is not required to contain the hang.
- No retry logic. A timed-out server is simply skipped for this bridge
  load; the user re-syncs or restarts pi once the underlying server is
  fixed or removed from canonical.
- No change to the three native-adapter (Claude Code/Codex/Kiro) MCP
  paths — those are each agent's own MCP client spawning the process,
  entirely outside Trellis's runtime control. This only touches code
  Trellis itself owns and executes: the pi bridge.
