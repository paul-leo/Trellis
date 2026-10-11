# Tasks

## 1. Schema and validation

- [x] 1.1 Extend the canonical server schema: `auth` accepts the existing
      `oauth` scalar or an object `{ kind: oauth, client_id?, client_secret_env? }`;
      a scalar and a metadata-less object must be equivalent.
- [x] 1.2 Apply the literal-value scan (`reject_patterns`) to `client_id` and
      `client_secret_env` values, refusing the file at load without printing
      the offending value.
- [x] 1.3 Validate `client_secret_env` as a variable name (no literal secrets)
      and `kind` as the only recognized discriminator.
- [x] 1.4 Demonstrate the object form in `schema/servers.example.yaml` with
      placeholder values only — no real provider client identifier.

## 2. Authorization flow

- [x] 2.1 In `runMcpAuth`, when canonical `client_id` is present, use it
      directly (skip RFC 7591 registration) and run the existing PKCE +
      loopback authorization-code flow.
- [x] 2.2 Keep Dynamic Client Registration as the fallback when `client_id`
      is absent.
- [x] 2.3 When registration is rejected (`unauthorized_client`) or no
      registration endpoint exists and no `client_id` is configured, fail
      non-zero with a remediation message pointing at `auth.client_id` in
      `~/.trellis/mcp/servers.yaml`.
- [x] 2.4 Resolve `client_secret_env` through `resolveSecretEnv` when present;
      never persist the resolved value outside the per-server token store.
- [x] 2.5 Persist the grant in `~/.trellis/mcp/oauth/<name>.json` (0600)
      paired with the client identity used, so refresh works unchanged.

## 3. CLI

- [x] 3.1 Add `trellis mcp set <name> --auth oauth --client-id <value>` and
      `--client-secret-env <NAME>` with the usual `--dry-run` / `--json`
      behavior; refuse a non-variable-name in the env position.
- [x] 3.2 Report pre-registered metadata presence in `trellis mcp list` /
      `--json` without echoing any secret.

## 4. Documentation

- [x] 4.1 Add `docs/mcp-oauth-matrix.md`: provider hosting matrix (DCR open
      vs allowlist), identification mechanism summary, per-provider
      confidence notes (Sentry marked as secondary-source evidence).
- [x] 4.2 Cross-link the matrix from the MCP/OAuth documentation and note
      that only provider-published identifiers may ever be pre-filled in
      distribution artifacts.

## 5. Verification

- [x] 5.1 Unit tests: schema acceptance (scalar/object/equivalence),
      reject_patterns refusal, variable-name validation, auth-flow ordering
      (static-id-wins, DCR fallback, actionable error), CLI flag behavior,
      sanitized listing output.
- [x] 5.2 Run the full test suite, typecheck, build, and package
      verification.
