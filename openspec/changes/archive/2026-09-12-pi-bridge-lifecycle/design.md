## Context

The pi bridge currently creates one MCP SDK `Client` per configured server and
leaves those clients open for the lifetime of the Node process. That is fine
for a long-lived interactive session, but the first local pi pilot showed that
`npx` and `node` MCP children can remain orphaned when pi is interrupted or
when the extension is reloaded. A failed `tools/list` call also leaves a
successfully connected client alive even though it can never register tools.

The bridge is an extension, so its lifecycle is controlled by pi rather than by
Trellis's CLI. The installed pi version exposes a `session_shutdown` extension
event and the bridge must remain duck-typed so it can still load on compatible
pi versions that do not expose the event.

## Goals / Non-Goals

**Goals:**

- Track every successfully connected MCP client created by the bridge.
- Close all tracked clients on pi's `session_shutdown` event.
- Close a client immediately when tool discovery fails.
- Keep cleanup idempotent and best-effort; cleanup errors must not mask the
  original connection or shutdown path.
- Preserve the current behavior where one unavailable server does not prevent
  other servers from registering tools.

**Non-Goals:**

- Do not change MCP transports, secret resolution, tool naming, or canonical
  configuration semantics.
- Do not kill MCP processes owned by another pi instance, Claude Code, Kiro,
  Codex, or mirasim.
- Do not promise cleanup after an uncatchable `SIGKILL` or machine crash.

## Decisions

### 1. Use pi's lifecycle event as the primary hook

The extension registers a `session_shutdown` handler when `pi.on` is
available. The handler closes every tracked `Client`, which delegates to the
MCP SDK transport and its stdio child process. This is preferable to a
global process handler because pi can reload or replace an extension session
without terminating the whole Node process.

### 2. Use a small optional duck-typed API surface

`PiExtensionAPI.on` is optional in Trellis's local interface. Older or test
hosts that only provide `registerTool` continue to work; they can still use
the bridge and explicitly own process cleanup. The real pi 0.85.1 runtime
provides the event.

### 3. Close failed-discovery clients immediately

After a connection succeeds, the client is added to the tracked set before
`tools/list`. If discovery fails, the bridge logs the existing diagnostic,
closes that client, and removes it from the set. This prevents a partially
connected server from leaking even when pi remains open.

### 4. Make cleanup idempotent

The same client may be reached by a discovery failure and a later shutdown
event. Cleanup removes it from the set before awaiting `close()`, and repeated
shutdown events therefore do not call the transport twice.

## Risks / Trade-offs

- [Risk] A pi version may not emit `session_shutdown` → Mitigation: keep the
  optional hook and document that hard process termination cannot be cleaned up;
  the local supported pi version does emit it.
- [Risk] A transport's `close()` may reject or hang → Mitigation: catch and
  report cleanup errors; use a bounded cleanup helper in tests and never block
  registration of unrelated servers on one cleanup failure.
- [Risk] Closing a client during a session replacement can briefly interrupt an
  in-flight tool call → Mitigation: pi defines `session_shutdown` as the point
  before extension teardown; closing at that boundary is safer than leaving
  the child alive across the new session.

## Migration Plan

No user configuration migration is required. Rebuild the bundled bridge and
run the existing pi pilot. A rollback is the existing symlink target or the
previous Git commit; no Claude Code, Codex, or Kiro file is changed.

## Open Questions

None for the current pi 0.85.1 pilot. A future pi API change can add a native
transport shutdown hook without changing the canonical MCP schema.
