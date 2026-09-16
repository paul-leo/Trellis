## 1. Shared connect/aggregation module extraction

- [x] 1.1 `src/lib/mcpConnect.ts`: extract `connectStdio`/`connectHttp`/
      `connectSse`/`withTimeout`/`connectWithCleanup`/`resolveHeaders`
      out of `src/pi-bridge/index.ts` into an agent-agnostic shared
      module; `pi-bridge/index.ts` imports from it, behavior unchanged
      (spec: gateway aggregation, connection-failure isolation)
- [x] 1.2 `src/lib/mcpToolRegistry.ts`: `<server>__<tool>` prefixing,
      `tools/list` aggregation across connected upstreams, `tools/call`
      routing back to the exact owning upstream connection (spec: tool
      prefix/routing requirement)
- [x] 1.3 `test/unit/mcpConnect.test.ts`: timeout + cleanup behavior
      matches `pi-bridge`'s existing tested behavior post-extraction
- [x] 1.4 `test/unit/mcpToolRegistry.test.ts`: same-named tools on two
      upstreams stay distinguishable and route correctly; one failed
      upstream doesn't block aggregation of the others
- [x] 1.5 `src/lib/gatewayBackend.ts`: declare the `GatewayBackend` seam
      (`listTools`/`callTool`/`close`) and v1's `LocalBackend`
      implementation, which owns the `mcpConnect` + `mcpToolRegistry`
      pair; this is the only surface `mcpGateway.ts` may depend on
      (design.md D11)
- [x] 1.6 `test/unit/gatewayBackend.test.ts`: `LocalBackend` satisfies
      the interface against fake upstreams; a second, stub
      implementation can be substituted without `mcpGateway.ts`
      changing — the property that makes v2's shared service an
      addition rather than a rewrite

## 2. Canonical schema: new gateway field

- [x] 2.1 `src/core/types.ts`: add `gateway?: GatewayConfig` to
      `McpConfig` — independent of `HubConfig` per design.md D5.
      `{ enabled: boolean; agents?: AgentId[] }`: `enabled` alone turns
      gateway mode on for every managed agent (the expected common
      case — gateway mode is not something a user should have to reason
      about per agent), with the optional `agents` narrowing it when
      someone does want a mixed setup
- [x] 2.2 `src/core/canonical.ts`: YAML read/write for the new field,
      following the existing `staticEnv`/`envAliases`
      snake_case-on-disk convention
- [x] 2.3 `schema/servers.example.yaml`: document the new field with an
      example

## 3. `resolveMcpPlan` gateway-convergence branch

- [x] 3.1 `src/adapters/mcpPlan.ts`: add the gateway branch — checked
      before the existing `hub` branch, mutually exclusive with it per
      agent, producing exactly one stdio `AdapterPlanItem` with
      `kind: "mcp"` whose command is `trellis mcp-gateway --agent <id>`
      for the agent being resolved (spec: one-entry convergence,
      gateway/hub orthogonality, no new `kind`)
- [x] 3.2 Confirm Codex's bearer-token-header-shape conflict check is
      skipped for any server when Codex is resolved in gateway mode
      (spec: Codex headers limitation does not apply in gateway mode)
- [x] 3.3 Add a `GATEWAY_ENTRY_NAME` constant alongside the existing
      `HUB_ENTRY_NAME` and give it the same `mcp.knownHostInjected`
      collision check the hub branch performs at
      `src/adapters/mcpPlan.ts:99-101` — report a conflict, write
      nothing (spec: gateway entry name collision)
- [x] 3.4 `test/unit/mcpPlan.test.ts`: gateway branch produces one entry
      regardless of server count, carrying the resolving agent's own id;
      gateway/hub coexist without error when set on different agents;
      enabling gateway for one agent doesn't affect another agent still
      in hub or direct mode; a host-injected name equal to
      `GATEWAY_ENTRY_NAME` produces a conflict and no entry

## 4. Gateway stdio server command

- [x] 4.1 `src/commands/mcpGateway.ts`: read the agent id from
      `--agent`, and on startup resolve the in-scope server set for that
      agent (respecting per-server `agents:` scope, `enabled: false`,
      and the managed-agents list — reusing existing scope-resolution
      logic, not a new mechanism), connect each via `mcpConnect`, and
      skip/log any that fail or time out without blocking the others
- [x] 4.2 Wire the aggregated result through `@modelcontextprotocol/sdk`'s
      `Server` + `StdioServerTransport`, implementing
      `ListToolsRequestSchema`/`CallToolRequestSchema` by delegating to
      a `GatewayBackend` (1.5) — `mcpGateway.ts` must not reference a
      connection, transport, or server definition directly (design.md
      D11)
- [x] 4.3 Resolve every upstream's `env`/`envAliases`/`staticEnv`/
      `headers` exclusively through `resolveSecretEnv`/
      `secrets.policy.yaml` before connecting; an unresolvable name
      causes that one upstream to be skipped, not connected with an
      empty value
- [x] 4.4 On startup, for any in-scope server requiring OAuth, check its
      stored token's expiry and silently perform a `refresh_token` grant
      if expired, before attempting to connect; never open a browser or
      block on interactive input
- [x] 4.5 Shutdown path: listen for `'end'` on `process.stdin` directly
      (the SDK's `StdioServerTransport` binds only `'data'`/`'error'`,
      so EOF never reaches `onclose`) and on that signal — and on
      `SIGTERM`/`SIGINT`/`SIGHUP` — close every upstream client,
      terminate every upstream child process, and exit. Without this,
      every agent session leaks a gateway plus its whole upstream set,
      since POSIX re-parents orphans instead of killing them (design.md
      D13; same bug class as the note at `src/pi-bridge/index.ts:77`)
- [x] 4.6 `test/unit/mcpGateway.test.ts`: scope filtering (agent-specific
      servers, disabled servers excluded), managed-agent scoping, secret
      resolution failure isolation, and that the gateway never resolves
      itself as one of its own upstreams
- [x] 4.8 Extend `test/unit/mcpGateway.test.ts` with
      silent-refresh-before-connect coverage once 4.4/5.4 exist (split
      out of 4.6, which is otherwise complete — the refresh path has
      nothing to test against yet)
- [x] 4.7 `test/unit/mcpGatewayShutdown.test.ts`: spawn the real gateway
      against a fake upstream, close its stdin, and assert both the
      gateway and the upstream child are gone — a process-level test,
      not a mocked one, since the whole failure mode is that a real
      process outlives its parent

## 5. OAuth module

- [x] 5.1 `src/lib/oauth/discovery.ts`: RFC 8414 metadata discovery
      (path-level, root-level `oauth-protected-resource`, and
      `WWW-Authenticate` fallback strategies)
- [x] 5.2 `src/lib/oauth/pkce.ts`: PKCE code verifier/challenge
      generation and S256 verification
- [x] 5.3 `src/lib/oauth/flow.ts`: dynamic client registration (RFC 7591)
      when available, authorization-code-plus-PKCE flow, local callback
      listener, token exchange
- [x] 5.4 `src/lib/oauth/refresh.ts`: `refresh_token` grant, callable
      both from `trellis mcp auth` and silently from the gateway
      subcommand; the grant and the write of its result run while
      holding 5.7's lock, and the stored token is re-read after
      acquiring it so a refresh another holder already completed is
      detected rather than repeated (design.md D16)
- [x] 5.5 `src/lib/oauth/store.ts`: read/write
      `~/.trellis/mcp/oauth/<server-name>.json`, creating the file with
      mode `0600`, one file per server, never touching `servers.yaml` or
      any OS keychain/credential manager
- [x] 5.6 `test/unit/oauth/discovery.test.ts`,
      `test/unit/oauth/pkce.test.ts`, `test/unit/oauth/flow.test.ts`,
      `test/unit/oauth/refresh.test.ts`, `test/unit/oauth/store.test.ts`:
      cover each module against a hand-built fake Authorization Server
      (metadata discovery, DCR, PKCE verification, token exchange,
      refresh grant, file permissions), matching the thoroughness of the
      research spike that validated this design
- [x] 5.7 `src/lib/oauth/lock.ts`: per-server exclusive lock at
      `~/.trellis/mcp/oauth/<server-name>.lock`, with stale-lock
      recovery so a killed holder can't wedge every later refresh;
      locks are per server, never global
- [x] 5.8 `test/unit/oauth/lock.test.ts`: two concurrent refreshes of
      one server produce exactly one grant against the fake
      Authorization Server and both end up with the same valid token; a
      refresh of a different server proceeds without waiting; a stale
      lock left by a dead holder is recovered rather than blocking
      forever

## 6. `trellis mcp auth` command + CLI wiring

- [x] 6.1 `src/commands/mcpAuth.ts`: `runMcpAuth(serverName)` — discovery,
      DCR, PKCE, browser open, local callback, token exchange, persist
      via `oauth/store.ts`; re-running for a server with a still-valid
      token is a no-op unless forced
- [x] 6.2 `src/cli.ts`: add `mcp auth <server-name>` to the existing `mcp`
      subcommand dispatch, alongside `sync`/`list`/`add`/`remove`
- [x] 6.3 `test/unit/mcpAuth.test.ts`: full flow against the fake
      Authorization Server, no-op on valid existing token, correct error
      reporting when a server has no OAuth metadata

## 7. Documentation

- [x] 7.1 `docs/architecture.md`: document the gateway's stdio-per-agent
      shape, the shared connect module, the `GatewayBackend` seam and
      why the shared-service form is a later substitution rather than a
      redesign, and how all of it relates to (and remains independent
      from) `hub` mode
- [x] 7.2 `docs/getting-started.md`: add a section on enabling gateway
      mode and running `trellis mcp auth` for a remote server that needs
      it
- [x] 7.3 `docs/roadmap.md`: update this change's entry once implemented

## 8. Full-suite verification

- [x] 8.1 Full project-wide test suite passes with zero regressions
- [x] 8.2 Typecheck and build succeed
