# Tasks

## 1. Canonical schema

- [x] 1.1 `McpAuthConfig` gains `clientName?: string`; YAML form accepts and
  validates `client_name` (string only), round-trips through
  `toServerDefYaml`, and unknown-key rejection lists it
- [x] 1.2 Unit tests: parse/serialize round-trip; non-string `client_name`
  refused; secrets reject-pattern check still scoped to
  `client_id`/`client_secret_env`

## 2. pi renderer

- [x] 2.1 `piRenderer` emits `oauth: { clientName }` on http OAuth entries
  that declare `client_name`; scalar `auth: oauth` unchanged (bare `{url}`)
- [x] 2.2 Unit tests: object-form entry renders the oauth block; sync
  converge/strip regression — an entry written by Trellis with
  `oauth.clientName` compares equal on the next plan (no drift)

## 3. Docs

- [x] 3.1 `docs/getting-started.md` pi section: `client_name` for providers
  that allowlist DCR client names (Figma), with the `pi mcp login` flow

## 4. Verification

- [x] 4.1 Full suite, typecheck, build
- [ ] 4.2 Real machine after release: canonical figma gets
  `auth: { kind: oauth, client_name: Claude Code }`, `trellis mcp sync`
  writes the oauth block, second sync is a no-op, `pi mcp login figma`
  reaches the browser
