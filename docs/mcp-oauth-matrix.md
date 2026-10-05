# Remote MCP providers — how OAuth identity works, and where Trellis can help

`trellis mcp auth <name>` can only complete an authorization-code grant if it
is allowed to *have* a client identity. Whether it may is entirely the
provider's decision, and that decision splits remote MCP providers into two
families. This page records which family each known provider is in, what
evidence that rests on, and what Trellis does in each case.

Read alongside docs/architecture.md §"Static header auth vs. real OAuth",
which covers the *other* shape — a long-lived bearer token or API key in a
`headers` field — and why Trellis builds for both.

## The two families

**DCR-open.** The provider implements RFC 7591 Dynamic Client Registration.
Trellis POSTs its own metadata, receives a `client_id`, and holds its own
identity per installation. Nothing a user has to supply; nothing Trellis has
to distribute. This already works: it is what `trellis mcp auth` has done
since `trellis-mcp-gateway-hosting`.

**Allowlist.** The provider refuses registration — either by not advertising a
`registration_endpoint`, or by answering it with `unauthorized_client` — and
requires clients to be pre-registered with the provider. There is no
self-service path: the user obtains a `client_id` out of band and supplies it.
That is what the `auth.client_id` / `auth.client_secret_env` fields exist for
(trellis-mcp-oauth-static-client design.md D1–D3).

The 2026-07-28 MCP authorization spec moved in the allowlist direction,
downgrading Dynamic Client Registration from a MUST to a MAY in favour of
pre-registration. Expect the second family to grow; the mechanism, not the
per-provider list, is what Trellis commits to.

## Matrix

| Provider | Family | What identifies the client | Evidence | Confidence |
|---|---|---|---|---|
| Sentry | DCR-open | `client_id` from DCR | Local successful grant against the real server; secondary sources describing its DCR endpoint | Medium — see the note below |
| Supabase | DCR-open | `client_id` from DCR | Same | Medium |
| Morphix | DCR-open | `client_id` from DCR | Same | Medium |
| GitHub | DCR-open | `client_id` from DCR | Same | Medium |
| Notion | DCR-open | `client_id` from DCR | Same | Medium |
| Linear | DCR-open | `client_id` from DCR | Same | Medium |
| Cloudflare | DCR-open | `client_id` from DCR | Same | Medium |
| Figma | Allowlist | Provider-published `client_id`, supplied by the user | Registration refused with `unauthorized_client` — observed directly, and the reason this change exists | High |

**On confidence.** "High" means the behavior was observed directly against the
live provider and the failure (or success) is reproducible from this
repository's own test fixtures. "Medium" means the status rests on a working
local grant plus secondary sources rather than a first-party policy statement —
the *observed* behavior is solid, but a provider is free to change its
registration policy at any time, and none of these have published a
contractual commitment either way. Sentry is explicitly in this bucket
(trellis-mcp-oauth-static-client design.md D6): the local grant proves
registration works today, not that it will next quarter.

Treat the whole table as a snapshot of observed behavior, not as provider
policy. `trellis mcp auth` reports the actual failure when a row goes stale —
see "When a provider refuses" below.

## What actually identifies a client

There is no magic header and no provider-specific handshake. Any OAuth 2.0
authorization server that speaks the MCP authorization profile identifies a
client by a combination of:

- **`client_id`** — the identity itself. Public by design for a public client:
  it travels in the browser URL on every authorization (`?client_id=...`), so
  it is visible to the user, their browser history, and any proxy in between.
  Its security rests on the *other* factors here, never on its secrecy.
- **Exact `redirect_uri` match** — registered with the client and required to
  match byte-for-byte. This is why Trellis's loopback callback is what it is:
  `http://127.0.0.1:<port>/callback`, with the port chosen by the OS at bind
  time. A pre-registered client whose provider pins one specific port is the
  one case where a fixed `callbackPort` is needed.
- **PKCE (RFC 7636, `S256`)** — the proof that whoever redeems the code is
  whoever started the flow. The verifier never travels through the browser;
  only its SHA-256 challenge does. Trellis's fake Authorization Server in the
  test suite *enforces* this rather than rubber-stamping it, so the tests
  cannot pass for a client that gets PKCE wrong.
- **`resource` parameter** — binds the grant to the MCP server it was issued
  for, so a token minted for one server is not replayable against another.

Nothing in that list is a secret for a public client, which is exactly why
`client_id` is a plain literal in canonical YAML and `client_secret_env` — the
one field that *is* a credential — is a variable NAME resolved through
`secrets.policy.yaml` and never a value (design.md D2).

## When a provider refuses

`trellis mcp auth <name>` tries pre-registered metadata first, then DCR. When
both are unavailable it fails with the remediation rather than a bare status
code:

```
"figma": dynamic client registration was refused (unauthorized_client) —
register a client with the provider and set auth.client_id (plus
auth.client_secret_env if the provider requires a secret) under this server in
~/.trellis/mcp/servers.yaml
```

The fix is then two commands:

```sh
trellis mcp set figma --auth oauth --client-id <provider-published-id>
trellis mcp auth figma
```

The id comes from the provider. Trellis does not ship one, look one up for
you, or read another client's stored credentials to borrow an identity —
that last option is rejected structurally, not just by policy (design.md D5:
borrowing a refresh token makes both clients fight over rotation, and reading
another tool's credential store would mean decrypting files Trellis does not
own).

## Distribution boundary

Trellis is open source. What it distributes is a mechanism — the schema field,
the flow, the tests. It does not distribute an identity.

A user who obtains a `client_id` and pastes it into their own
`~/.trellis/mcp/servers.yaml` is making their own decision under the provider's
terms, in the same position as anyone running `mcp-remote
--static-oauth-client-info`. Trellis shipping that same id in
`schema/servers.example.yaml`, in this page, or in seed data would instead make
the project itself the distributor of a whitelist-bypass tool. So:

- Examples and docs use placeholders only — see the commented block in
  `schema/servers.example.yaml`.
- Only provider-**published** identifiers may ever be pre-filled. None exist
  today, so nothing is pre-filled.
- A literal that matches `reject_patterns` is refused at load and at write, so
  a pasted credential cannot quietly become part of the canonical source.

## See also

- docs/architecture.md §"Static header auth vs. real OAuth" — the other shape.
- `schema/servers.example.yaml` — the object form, with placeholders.
- trellis-mcp-oauth-static-client design.md — D1 (field shape), D2 (literal vs.
  name), D3 (metadata wins over DCR), D4 (distribution boundary), D5 (no token
  borrowing), D6 (this matrix's confidence notes).
