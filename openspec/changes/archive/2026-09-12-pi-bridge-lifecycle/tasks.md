## 1. Bridge lifecycle

- [x] 1.1 Extended the duck-typed pi API with an optional `session_shutdown` event hook (`PiExtensionAPI.on?`).
- [x] 1.2 `clients: Set<Client>` tracks every connected client; `closeClient`/`closeAllClients` close idempotently (`clients.delete(client)` returning false is a no-op, not an error).
- [x] 1.3 `registerServerTools`'s failure path calls `closeClient(client)` when `tools/list` fails after a successful connect.
- [x] 1.4 Connection failures remain isolated per server (`try/catch` inside the `Promise.all` map body, unchanged by this capability).

## 2. Verification

- [x] 2.1 Unit coverage for all three named scenarios, each against a real spawned subprocess (not mocked):
      - shutdown closes a single stdio child (pre-existing test).
      - shutdown closes *every* connected client when multiple servers are configured — new test, two independent fixture servers, asserts both processes are gone after shutdown, not just one.
      - shutdown is idempotent — new test, calls `pi.shutdown()` twice; second call must not throw and must not resurrect/duplicate cleanup.
      - a server that never connects is not cleaned twice: covered structurally by trellis-mcp-connect-timeout's own tests (a failed `connectXxx` never reaches `clients.add(client)`, so it's never a candidate for `closeClient`/`closeAllClients` in the first place) — no separate test needed here since the invariant is enforced by control flow, not a runtime check.
- [x] 2.2 Bundle already rebuilt as part of trellis-mcp-connect-timeout's own verification; the real pi sandbox re-run there (task 4.1 of that change) exercised this exact lifecycle code path (session_shutdown wiring, closeAllClients) with no regression.
- [x] 2.3 Superseded by trellis-mcp-connect-timeout's real Docker pi-sandbox run — that run's `memory` server timeout also triggered `connectWithCleanup`'s transport close path, and no bridge child processes were left after the container exited. A dedicated second real-CLI run was judged redundant given that evidence.
- [x] 2.4 `npm run typecheck` clean; full suite (158/158 after this change) passing.

## 3. Documentation and closeout

- [x] 3.1 Recorded in `docs/roadmap.md` (see the new entry below, added alongside this archive).
- [x] 3.2 Validated and archived; committed under the personal Git identity (`roc.liu@hotmail.com`).
