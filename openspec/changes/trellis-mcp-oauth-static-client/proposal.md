# Proposal

## Why

Whether `trellis mcp auth` can complete an OAuth grant depends entirely on the
provider's client registration policy, and that policy splits the ecosystem in
two:

- Providers with Dynamic Client Registration (Sentry, Supabase, Morphix,
  GitHub, Notion, Linear, Cloudflare) let Trellis register its own client and
  hold its own identity. This already works today.
- Allowlist providers (Figma, and — per the 2026-07-28 MCP spec downgrading
  DCR to MAY in favor of pre-registration — more over time) reject our
  registration with `unauthorized_client`. The OAuth store stays empty, the
  server can never be authorized through Trellis, and Pi-bridge users cannot
  reach it at all.

Research (docs/mcp-oauth-matrix.md, added here) shows the only sanctioned way
to reach an allowlist provider from a third-party client is pre-registered
client metadata: the user supplies a known-good `client_id`, the client runs
its own PKCE authorization-code flow. That is exactly what `mcp-remote
--static-oauth-client-info` and `claude mcp add --client-id` already do in the
open-source ecosystem.

## What Changes

- Extend the `auth: oauth` classification to optionally carry pre-registered
  client metadata: `client_id` (literal — public clients publish it by design)
  and `client_secret_env` (a variable NAME resolved through secrets.policy,
  never a literal).
- `trellis mcp auth <name>` prefers pre-registered metadata when present;
  Dynamic Client Registration remains the fallback when absent. When neither
  path can produce a client, the command fails with an actionable message.
- `trellis mcp set` gains `--client-id` / `--client-secret-env` management
  with the usual `--dry-run` / `--json` behavior.
- Security boundary, made normative:
  - DCR-issued and flow-obtained credentials live only in
    `~/.trellis/mcp/oauth/<name>.json` (0600) — never in canonical YAML.
  - The literal-value scan (`reject_patterns`) covers the new fields so a
    pasted secret is refused, not silently written.
  - `mcp list` / `mcp auth` output never echoes secret values.
  - `schema/servers.example.yaml` demonstrates the field shape with
    placeholders only. Trellis never ships a reverse-engineered client_id in
    the repository: filling one in is the user's decision, not ours.
- Add `docs/mcp-oauth-matrix.md`: the provider hosting matrix (DCR open vs
  allowlist), identification mechanism summary, and per-provider confidence
  notes.

## Capabilities

### Modified Capabilities

- `mcp-auth-routing-policy`: the OAuth classification carries optional
  pre-registered client metadata under a names-only secret discipline, and the
  auth flow uses it before attempting Dynamic Client Registration.

## Impact

- Canonical MCP schema and its validation, `trellis mcp auth` / `mcp set` /
  `mcp list`, the OAuth flow module, and docs.
- Existing `auth: oauth` scalars keep their exact meaning; no server is
  reclassified and no stored token is touched.
- Refresh tokens keep their existing single-owner semantics — Trellis never
  imports or shares another client's tokens (no Keychain reading, no token
  borrowing; that option is rejected on rotation-revocation grounds, e.g.
  Notion's 2-active-connection replay protection).
- Out of scope, to be proposed separately once stored tokens for allowlist
  providers exist: per-server `gateway-oauth` routing where the gateway
  proxies an OAuth server using Trellis's own token store (generalizing what
  the Pi bridge already does).
