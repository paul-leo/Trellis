# Design

## Goals / Non-Goals

**Goals:**

- Ensure an upstream transport that fails to connect is closed best-effort
  within a bounded time.
- Return control to `LocalBackend.connect` so it can drop the failed upstream
  and let the Runtime expose built-in providers.
- Keep the original connection error as the warning; cleanup errors must not
  mask it.

**Non-Goals:**

- Do not change per-upstream connection timeout values in this change.
- Do not make remote MCP authentication interactive.
- Do not hide warnings about unavailable upstreams.

## Decision

When `client.connect(transport)` fails or times out, `connectWithCleanup`
attempts `transport.close()` with a short bounded cleanup timeout. A cleanup
timeout is swallowed as best-effort cleanup, and the original connection
failure is rethrown. This keeps the existing caller-level failure isolation
while preventing a transport implementation from extending Gateway startup
past the Agent's startup deadline.

## Verification

- A fake transport whose `close()` never settles returns from
  `connectWithCleanup` within the cleanup bound and preserves the original
  connection error.
- A Gateway with one hanging/failed upstream still exposes SkillProvider and
  MemoryProvider tools through a real MCP handshake.
- Existing timeout, cleanup, and full test suites remain green.
