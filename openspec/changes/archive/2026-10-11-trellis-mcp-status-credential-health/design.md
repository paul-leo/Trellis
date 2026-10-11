# Design

## D1: Credential health is reported as `credential`, never `status`

For an OAuth-classified server the gateway owns nothing: the agent's own
MCP client holds the connection, and the gateway process cannot observe
whether that connection is up, stale, or rejected. What Trellis *can*
know — because it owns the token store — is whether the stored credential
will authenticate the next call. Reporting that under a field named
`status` would invite Agents to read `credential: "valid"` as "the
server is ready", a claim Trellis cannot make. The section is named
`oauth` and the field `credential` so the honest statement ("your stored
credential is healthy") is never confusable with the dishonest one
("the server is connected").

## D2: One classifier, now with its expiry surfaced

trellis-mcp-oauth-renew's design.md D2 established that renew, doctor,
and any future reader share a single status computation so their reports
can never disagree. This change's reader needs one more datum — *when*
the credential expires — so `renew.ts` grows `describeStoredToken`
returning `{ status, expiresAt? }`, and `classifyStoredToken` becomes a
projection of it. The classification logic itself does not move and does
not gain a second copy.

## D3: The status tool stays strictly read-only

The tool is annotated `readOnlyHint: true`; that annotation must remain
true. The oauth section classifies from the token file only — no
refresh attempt, no token-endpoint contact, no writes. A credential
reported `expired-renewable` might be silently refreshed by the next
real upstream call; the remediation text says exactly that
(`trellis mcp renew` to attempt it now), which is the same pointer
doctor gives. Interactive authorization remains exclusively
`trellis mcp auth`'s job (mcp-gateway-hosting design.md D9).

## D4: The OAuth set comes from the plan, not a parallel filter

`resolveGatewayUpstreams` currently pre-filters OAuth servers out of the
map before calling `resolveMcpPlan`. Instead it now passes the full map
and splits the result: `desired` entries whose def is OAuth-classified
become the `oauthServers` name list, the rest remain upstreams. This is
provably the same set `mcp sync` writes as direct entries in gateway
mode — `resolveMcpPlan`'s gateway branch runs the identical
`planDirectServers` checks (enabled, scope, route.servers,
known-host-injected collisions, literal-secret refusal, unresolved env
names) over the same predicate — so the status tool can never report a
server the agent doesn't actually have, or omit one it does. Hub-mode
agents get an empty list, matching hub mode writing no direct entries.

## D5: Additive output shape

```
{ servers: [ { name, transport, status, toolCount?, detail?, ... } ],
  oauth:   [ { name, credential, expiresAt?, remediation? } ] }
```

`servers` keeps every field it has today; `toolCount` is optional and
mirrors the number already in `detail`. `oauth` is always present (empty
array when the agent has no OAuth-classified servers) so consumers can
rely on the key existing. `remediation` is omitted for `valid` —
no action to take — and `expiresAt` is ISO 8601 when the stored token
carries an expiry at all. No token values, refresh tokens, or secret
material of any kind appear in either section.
