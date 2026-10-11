# Design: OAuth client_name

## D1 — One canonical field, snake_case on disk

`auth: { kind: oauth, client_name: <string> }` joins `owner`, `client_id`,
`client_secret_env` in the object form. Like `client_id`, the value is public
metadata (a display name the agent asserts at DCR time), so it lives in
servers.yaml directly — the secrets policy is not involved, and the load-time
reject-pattern check stays scoped to `client_id`/`client_secret_env`.

## D2 — Only the pi renderer consumes it (today)

`piRenderer` emits `oauth: { clientName }` on http entries whose auth is
OAuth with a `client_name` — exactly the shape `pi mcp add
--oauth-client-name` writes (verified against pi 1.1.0). Scalar `auth: oauth`
carries no name and renders as before. Claude Code, Codex and friends keep
their own registration names; if another agent grows the same need, its
renderer reads the same field.

## D3 — Ownership semantics unchanged

`client_name` is orthogonal to `owner`: an agent-owned server with a client
name is still authorized by the agent (`pi mcp login <name>`); a
trellis-owned entry never renders into pi's mcp.json at all. The field is
ignored by the gateway/runtime OAuth flow, which registers under Trellis's
own name.

## Verified facts (2026-10-11, this machine)

| Probe | Result |
|---|---|
| POST register, `client_name: "pi"` | 403, plain-text `Forbidden` |
| POST register, `client_name: "Claude Code"` | 200, full client metadata |
| UA variation (curl / browser / node) | no effect — name-gated, not WAF |
| `pi mcp add --oauth-client-name X` | writes `oauth: { clientName: X }` |
| pi mcp.json hot reload | none — `/reload` or restart |
