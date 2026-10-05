# Design

## D1 — Field shape: scalar stays, object extends

`auth: oauth` (scalar) remains valid and keeps its exact current meaning.
The classification also accepts an object form:

```yaml
auth:
  kind: oauth
  client_id: "public-by-design"     # literal, public client only
  client_secret_env: FIGMA_CLIENT_SECRET   # variable NAME, optional
```

Rationale: every existing canonical file (`auth: oauth` on `figma` today)
loads unchanged; the object form is purely additive. `kind` (not `type`)
avoids colliding with the transport vocabulary already used in this schema.

## D2 — Why `client_id` is a literal but `client_secret_env` is a name

A public client's `client_id` is published by design: it appears in the
browser redirect on every authorization (`?client_id=...`), and comparable
open-source tools (`mcp-remote --static-oauth-client-info`, `claude mcp add
--client-id`, E.D.D.I's documented client_id) treat it as non-secret. Its
security rests on PKCE + loopback redirect, never on the id's confidentiality.

A `client_secret` is the opposite — a real credential. It enters the system
only as a variable name resolved through the existing `secrets.policy.yaml`
machinery (`resolveSecretEnv`), exactly like `env:` entries. There is
deliberately no literal secret field, mirroring the header rule in
`schema/servers.example.yaml`: "env values are variable NAMES only."

Concretely: allowlist providers rarely need a secret at all (public client +
PKCE); the field exists for the confidential-client corner cases so they have
a sanctioned path instead of an `static_env` workaround.

## D3 — Pre-registered metadata wins over DCR

`runMcpAuth` order of operations:

1. If canonical carries `client_id` → use it directly (skip RFC 7591
   registration), still running the full PKCE + loopback flow.
2. Else attempt Dynamic Client Registration (current behavior).
3. If registration fails with `unauthorized_client` (or the AS advertises no
   registration endpoint) → fail with an actionable message naming the exact
   remediation: add `client_id` under `auth:` in `~/.trellis/mcp/servers.yaml`.

The token store already persists `clientId` (and optional `clientSecret`) per
server, so refresh after a static-client grant works unchanged — the stored
grant and the stored client identity stay paired.

## D4 — Distribution boundary: mechanism ships, borrowed values don't

Trellis is an open-source project; what it distributes is behavior, not
identity. A user pasting a reverse-engineered Figma `client_id` into their own
`~/.trellis/mcp/servers.yaml` makes their own choice under the provider's
terms — same position as `mcp-remote`. Trellis shipping that id in
`schema/servers.example.yaml`, docs, or seed data would instead make the
project itself the distributor of a whitelist-bypass tool. Therefore:

- Example/docs use placeholders (`client_id: "<published-or-user-supplied>"`).
- Only provider-**published** ids (E.D.D.I-style) may ever be pre-filled, and
  none exist today, so nothing is pre-filled.

## D5 — No token borrowing, structurally

Rejected alternatives, recorded so they are not re-proposed:

- Sharing another client's refresh token: public-client rotation makes this a
  mutual kick-out (Notion keeps 2 active connections and revokes the whole
  grant on replay detection).
- Reading Codex/Claude Code credential stores: their Keychain entries are
  absent for the very providers that need help (local inspection found no
  Figma/Sentry entry in `Codex MCP Credentials`; Claude Code's Figma connector
  holds tokens server-side at claude.ai, not locally), reading them would
  trigger TCC prompts, and docs/architecture.md §"Static header auth vs. real
  OAuth" already rules out takeover.

## D6 — Matrix documentation with confidence notes

`docs/mcp-oauth-matrix.md` records the provider split (DCR-open vs allowlist),
the identification mechanics (client_id + exact redirect_uri + PKCE + resource
parameter; no magic headers), and marks evidence quality per row — e.g.
Sentry's "open" status rests on secondary sources plus the local successful
grant, not a first-party policy statement.

## D7 — Out of scope: `gateway-oauth` routing

Routing an OAuth-classified server through the gateway with Trellis-held
tokens (generalizing the Pi bridge path) is a separate change. It depends on
this one (there must be a stored token to proxy first) and touches
`mcp-gateway-hosting`; bundling it here would couple a schema change to a
routing migration.
