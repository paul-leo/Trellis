# Tasks

## 1. Shared classifier surfaces the expiry

- [x] 1.1 `src/lib/oauth/renew.ts`: add `describeStoredToken(homeDir,
  serverName, opts)` returning `{ status, expiresAt? }` (ISO 8601);
  reimplement `classifyStoredToken` as a projection of it so there is
  still exactly one classification computation (design.md D2).
- [x] 1.2 Extend `test/unit/oauth/renew.test.ts`: expiresAt present for
  expiring tokens, absent for never-expiring tokens and for
  `no-token`/`unreadable`; `classifyStoredToken` results unchanged.

## 2. Structured tool count

- [x] 2.1 `src/lib/gatewayBackend.ts`: `UpstreamStatus.toolCount?`;
  set it at the `ready` site (`tools.length`) and the router-degraded
  site (`0`); `detail` strings unchanged (design.md D5).
- [x] 2.2 Extend `test/unit/gatewayBackend.test.ts`: ready status carries
  the tool count; degraded router carries 0.

## 3. Status provider oauth section

- [x] 3.1 `src/lib/mcpStatusProvider.ts`: constructor options
  `{ homeDir?, oauthServers? }`; output gains `oauth` entries shaped
  `{ name, credential, expiresAt?, remediation? }` via
  `describeStoredToken` + `remediationFor`; `oauth: []` when unconfigured;
  tool description updated (design.md D1/D3/D5).
- [x] 3.2 New `test/unit/mcpStatusProvider.test.ts` against a scratch
  home and a stub backend: `servers`-only output when unconfigured;
  `valid` with `expiresAt` and no remediation; `no-token` → auth
  remediation; expired + refresh token → `expired-renewable` + renew
  remediation; unreadable file → `unreadable`; no token values anywhere
  in text or structuredContent; unknown tool name still errors.

## 4. Gateway wiring

- [x] 4.1 `src/commands/mcpGateway.ts`: `resolveGatewayUpstreams` stops
  pre-filtering OAuth servers and instead splits the `resolveMcpPlan`
  result, returning `oauthServers` names alongside `upstreams`
  (design.md D4); hub mode returns an empty list; comments updated.
- [x] 4.2 `runMcpEdge` passes `{ homeDir, oauthServers }` to
  `McpStatusProvider`.
- [x] 4.3 Extend `test/unit/mcpGateway.test.ts`: in-scope OAuth server
  lands in `oauthServers`, not `upstreams`; scoped-out / disabled OAuth
  server appears in neither; existing upstream assertions unchanged.

## 5. Docs and validation

- [x] 5.1 Update the `trellis.mcp.status` paragraph in
  `docs/getting-started.md` to mention the credential-health section and
  structured tool count.
- [x] 5.2 Full test suite (842/842 pass, +16 new), typecheck, build.
- [x] 5.3 `openspec validate trellis-mcp-status-credential-health --strict`.
- [x] 5.4 Real-machine smoke (read-only, no gateway spawn):
  `resolveGatewayUpstreams` against the real home splits figma/sentry/
  supabase/morphix into `oauthServers` for claude-code/codex, pi sees
  only its scoped figma/sentry, and the ordinary upstream set is
  unchanged.
