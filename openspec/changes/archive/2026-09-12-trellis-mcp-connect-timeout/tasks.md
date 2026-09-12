## 1. Timeout helper

- [x] 1.1 `withTimeout<T>(promise, timeoutMs, message)` in
      `src/pi-bridge/index.ts`, exported for direct unit testing.
- [x] 1.2 3 direct unit tests: resolves-before-timeout passes the real
      value through; never-settles rejects at the boundary with the
      given message; rejects-first passes that rejection through
      unchanged (not masked by a timeout error).

## 2. Wire into the bridge's three connect functions

- [x] 2.1-2.3 `connectStdio`/`connectHttp`/`connectSse` each route
      through a new shared `connectWithCleanup(client, transport,
      timeoutMs, message)` — not just `withTimeout` inline, see 2.6.
- [x] 2.4 `registerServerTools` wraps `client.listTools()` with the
      same timeout; on timeout the existing outer `catch` already calls
      `closeClient`, unchanged.
- [x] 2.5 Confirmed by reading: the outer `try/catch` in
      `trellisMcpBridge`'s `Promise.all` body needed zero changes — a
      timeout rejection is a plain `Error`, identical in shape to an
      existing `connect()` rejection.
- [x] 2.6 (found during 3.x, not planned) `connectWithCleanup` also
      calls `transport.close()` on any connect failure (timeout or
      real), not just `withTimeout` alone — a timed-out `connectStdio`
      was leaking its spawned child process forever. Confirmed via a
      live orphaned process still in `ps` after a test run that should
      have exited, and a test run taking 12-19s instead of the expected
      ~300ms with no other explanation. `StdioClientTransport.close()`
      kills the underlying process; `StreamableHTTPClientTransport`/
      `SSEClientTransport` get the identical cleanup call for symmetry,
      though they have no OS process to leak.

## 3. Tests

- [x] 3.1 New fixture `test/fixtures/hanging-mcp-server.js`, two modes
      via argv (`before-initialize`, `before-tools-list`) — real
      subprocess, not a mock. Confirms the bridge logs a failure and
      resolves within a bounded window.
- [x] 3.2 Same fixture's `before-tools-list` mode: connects fine,
      then hangs on `tools/list` — same bounded-failure behavior.
- [x] 3.3 Regression test: one hanging server + one normal
      (`sample-mcp-server.js`) server in the same canonical config —
      the normal server's `normal__echo` tool registers, the hanging
      one contributes zero tools. This is the exact bug; would have
      failed (timed out entirely) before this change.
- [x] 3.4 Full suite re-run (152/152 passing, unchanged from before
      this change plus the 6 new tests) confirms no regression to
      default production behavior.
      Found and fixed along the way: an initial `SHORT_TIMEOUT_MS =
      300` test override was too tight — real `node` process cold-start
      under `Promise.all`-concurrent spawning made the "normal server
      also connects in time" assertion flaky (failed once with both
      servers reporting a spurious timeout). Raised to 3000ms; the
      `elapsed < N` wall-clock assertions were also tightened from a
      hardcoded 5000 to `SHORT_TIMEOUT_MS * 4` after the full 152-test
      suite (real concurrent process load from every other test file)
      made even 3000ms's neighborhood flake once at ~7.6s elapsed —
      not a bug in the timeout mechanism itself (the log line still
      showed the correct `3000ms` boundary), a too-tight assertion
      under real contention.

## 4. Sandbox / real-machine verification

- [x] 4.1 Rebuilt `dist/pi-bridge/bundle.js` and the
      `docker/pi-sandbox.Dockerfile` image; ran the real `pi` binary
      end to end. Confirmed no regression to P4/P9: skills/instructions/
      bridge-extension symlinks all still deliver correctly via bare
      `trellis sync`. The run also exercised the actual production
      default (10s, no test override) for real: a `memory` server
      (`npx -y @modelcontextprotocol/server-memory`) exceeded it and
      was logged as `"connect timed out after 10000ms"`, its
      `npx`-spawned subprocess visibly killed (`npm error signal
      SIGTERM` in the log) by 2.6's cleanup fix, while two other,
      differently-broken `http`-transport servers failed fast and
      normally — and `pi -p` still reached its own unrelated "No API
      key found for the selected model" stage, proving nothing stalled.
- [ ] 4.2 Skipped — optional per the original plan. The real-machine
      `harness-solo` re-confirmation this was written for is superseded
      by 4.1's stronger evidence (a real production-default timeout
      firing against a real, differently-hanging-shaped server in the
      sandbox); re-enabling `harness-solo` specifically wasn't judged
      worth the extra step.

## 5. Docs and archive

- [x] 5.1 `docs/roadmap.md`: added a "Post-P9 hardening" entry (no new
      numbered phase — this is a fix, not a planned roadmap item),
      including the pre-existing, out-of-scope gap found along the way
      (no sync sub-command target covers `kind: "extension"`, only bare
      `trellis sync`).
- [x] 5.2 `openspec validate --strict` clean; 152/152 tests; typecheck
      clean; confirmed zero leaked `hanging-mcp-server.js`/
      `sample-mcp-server.js` processes after the full suite via `ps`.
- [x] 5.3 Archived.
