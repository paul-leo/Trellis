## 1. Core types

- [x] 1.1 `src/core/types.ts`: `Transport` gained `"sse"`; added
      `headers?: Record<string, string>` to `McpServerDef`; removed the
      dead `auth?: "oauth" | "bearer-env"` field.

## 2. Shared var-name extraction (design.md D6)

- [x] 2.1 `src/lib/envVarNames.ts`: `extractTemplateVarNames(value)`
      parses every `${NAME}` occurrence. `extractJsonEnvVarNames` now
      also scans each server's `headers` object *values* through it.
      `extractTomlEnvVarNames` now also matches a
      `bearer_token_env_var = "VAR"` line (bare name, like `env_vars`).
- [x] 2.2 New `declaredEnvNames(def): string[]` — `env` names ∪ names
      extracted from `headers` values. Used by both `findMissingEnvValues`
      and `KiroAdapter.desiredApprovedEnvVars`, replacing their previous
      `def.env ?? []`-only collection.

## 3. Claude Code / Kiro rendering (design.md D3)

- [x] 3.1 `src/adapters/jsonMcp.ts`'s `renderJsonServerEntry`: `http`/`sse`
      branch now sets `type` to the matching discriminator and includes
      `headers: def.headers` only when non-empty.

## 4. Codex rendering (design.md D4)

- [x] 4.1 `src/lib/tomlSection.ts`: new exported
      `codexBearerTokenEnvVar(def)` — the single shape Codex's real
      schema can express (`{Authorization: "Bearer ${VAR}"}`, verified
      against `codex mcp add --bearer-token-env-var`'s real generated
      TOML). `renderServerSection`'s non-stdio branch renders
      `bearer_token_env_var = "VAR"` when it matches, nothing otherwise.
- [x] 4.2 `src/adapters/mcpPlan.ts`'s `resolveMcpPlan`: when
      `agentId === "codex"` and `headers` is set but doesn't match the
      bearer-token shape, produces a `"conflict"` entry naming the
      server and explaining the limitation, instead of adding it to
      `desired` — every other in-scope agent for the same server is
      unaffected. Also extended `findLiteralSecret`'s candidate list to
      include `headers` values (a literal secret embedded in a header
      is refused the same way one in `env`/`command`/`args`/`url` is).

## 5. Kiro approved-env-vars + secrets audit pick up headers (design.md D6)

- [x] 5.1 `src/adapters/kiro.ts`'s `desiredApprovedEnvVars` now uses
      `declaredEnvNames`.
- [x] 5.2 `src/commands/secretsAudit.ts`'s `findMissingEnvValues` now
      uses `declaredEnvNames`.

## 6. pi bridge (design.md D5)

- [x] 6.1 `src/pi-bridge/index.ts`: new `resolveHeaders(def, policy)`
      shared by `connectHttp` (extended to accept the full `def`, not
      just `url`) and new `connectSse` (mirrors `connectHttp` via
      `SSEClientTransport`) — both pass resolved headers as
      `requestInit.headers`. Dispatch in `trellisMcpBridge` now branches
      on `http` / `sse` / stdio explicitly.
- [x] 6.2 Rebuilt the bundle; `grep "^import "` on
      `dist/pi-bridge/bundle.js` shows only `node:*` builtins — zero new
      unresolved bare-specifier imports (the SDK's `SSEClientTransport`
      bundled cleanly, same as `StreamableHTTPClientTransport` in P4).

## 7. Unit tests

- [x] 7.1 `test/unit/envVarNames.test.ts`: 8 new tests —
      `extractTemplateVarNames`, a `bearer_token_env_var` line, a
      headers-embedded name via `extractJsonEnvVarNames`,
      `declaredEnvNames` union/empty cases.
- [x] 7.2 `test/unit/jsonMcp.test.ts`: 2 new tests — `http`/`sse` with
      `headers` render verbatim.
- [x] 7.3 `test/unit/tomlSection.test.ts`: 6 new tests —
      `codexBearerTokenEnvVar`'s shape recognition (and its four
      negative cases), `renderServerSection` rendering
      `bearer_token_env_var` for the matching shape and nothing for a
      non-matching one.
- [x] 7.4 `test/unit/mcpPlan.test.ts`: 3 new tests — a bearer-token
      shape is desired for Codex; a non-bearer-token shape is a
      Codex-only conflict while Claude Code still gets it; a literal
      secret in a `headers` value is refused.
- [x] 7.5 `test/unit/kiroApprovedEnvVars.test.ts`: 1 new test — a
      headers-only (no `env`) server contributes its embedded name.
- [x] 7.6 `test/unit/secretsAudit.test.ts`: 2 new tests — a
      headers-embedded name in a real on-disk config outside
      `allowed_vars` is an `unexpected-var-name` finding; a headers-only
      canonical server with an unresolvable name is a
      `missing-env-value` finding.
- [x] 7.7 `test/unit/piBridge.test.ts`: 1 new test, real-network (not
      mocked) — a plain `node:http` server captures the actual incoming
      request's headers; confirms the bridge's real outbound HTTP POST
      carries the resolved `Authorization: Bearer <value>` header,
      distinguishing it from the unresolved `${VAR}` template.
      Full suite: 145/145 pass (124 pre-existing + 21 new).

## 8. Sandbox verification (real container)

- [x] 8.1 Added two real fixture servers to the shared
      `test/fixtures/home/.trellis/mcp/servers.yaml` (with their var
      names added to the fixture's `secrets.policy.yaml` allow-list, to
      keep the existing "zero findings by construction" baseline
      intact for every other phase's own sandbox runs): `remote-bearer`
      (single bearer-token `headers` shape) and `remote-multi-header`
      (two headers — the shape Codex can't express). Ran real
      `trellis mcp sync` in `docker/sandbox.Dockerfile`: Claude Code's
      and Kiro's real config files both gained `remote-bearer` and
      `remote-multi-header` with `headers` rendered verbatim; Codex's
      real `config.toml` gained `remote-bearer` as
      `bearer_token_env_var = "REMOTE_BEARER_TOKEN"` (no `headers` key).
- [x] 8.2 Same real run: Codex's report showed a conflict for
      `remote-multi-header` with the exact expected message ("its
      `headers` field isn't the single ... shape ... Codex has no
      generic headers concept"), while Claude Code's and Kiro's reports
      show it created normally — confirmed by reading both real files
      directly afterward.
- [x] 8.3 Two further real, ephemeral (container-local-only, never
      touching the checked-in fixture) `secrets audit` runs: (a) a
      canonical server with a headers-embedded name absent from
      `allowed_vars` and unresolvable anywhere → real CLI reported
      `missing-env-value`, exit 1; (b) the same name written directly
      into a real `.claude.json`'s `headers` value, with the ambient
      env set so only the *other* check is exercised → real CLI
      reported `unexpected-var-name` naming
      `/root-scratch/.claude.json`, confirming the on-disk-config-scan
      path (not just the canonical-side check) sees names embedded in
      `headers`, not just `env`.

## 9. Docs

- [x] 9.1 `docs/architecture.md`: documented the real, per-agent OAuth
      boundary (Claude Code's `--client-id`/`--client-secret`/
      `--callback-port`; Codex's `mcp login`/`logout`; Kiro's own
      `oauth`/`oauthScopes` schema fields) — Trellis delegates, never
      reimplements, for all three; pi has no equivalent and gains none.
- [x] 9.2 `docs/roadmap.md`: added this phase's entry.
