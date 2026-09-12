## Why

The first real pi pilot showed that the bridge can connect and register tools, but its stdio MCP child processes outlive a pi process that exits abruptly or is interrupted. This leaks orphaned `node`/`npx` servers and makes local validation noisy and unsafe. The bridge needs to own the lifecycle of every client it starts.

## What Changes

- Track every connected MCP client and close its transport when pi shuts down or the extension is reloaded.
- Close a client when tool discovery fails after connection, rather than leaving its child process running.
- Keep cleanup best-effort and non-blocking so one broken server cannot prevent pi from shutting down.
- Add real child-process lifecycle regression tests and verify the behavior through the local pi CLI.

## Capabilities

### New Capabilities

- `pi-bridge-lifecycle`: Own and release MCP transports created by the pi bridge.

### Modified Capabilities

None. The lifecycle contract is additive and is isolated in the new capability.

## Impact

- Affects `src/pi-bridge/index.ts`, its bundled extension, and bridge tests.
- Uses pi's `session_shutdown` extension event when available, with a process-signal fallback for the CLI process.
- No changes to Claude Code, Codex, Kiro, their native configuration, or secret values.
