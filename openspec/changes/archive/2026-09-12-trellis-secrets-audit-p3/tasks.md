## 1. Canonical source: read secrets.policy.yaml

- [x] 1.1 `src/core/canonical.ts`'s `loadSecretsPolicyYaml()` parses
      `~/.trellis/secrets.policy.yaml` into `CanonicalSource.secretsPolicy`.
      Missing file → empty policy, not an error.
- [x] 1.2 `test/unit/canonical.test.ts`: populated policy → matching
      `allowedVars` and compiled `rejectPatterns` (verified as real
      `RegExp` instances that actually match/don't match).
- [x] 1.3 `test/unit/canonical.test.ts`: missing policy → empty, valid
      config, not a thrown error.
- [x] 1.4 Fixed the stale `src/adapters/secretsGuard.ts` reference in
      `canonical.ts`'s comment — P2's guard actually lives in
      `src/adapters/mcpPlan.ts`.

## 2. `src/lib/envVarNames.ts` — env-var-name extraction (design.md D1)

- [x] 2.1 `extractJsonEnvVarNames` — parses real JSON, walks
      `mcpServers[*].env` keys.
- [x] 2.2 `extractTomlEnvVarNames` — narrow `env_vars = [...]` line regex.
- [x] 2.3 `test/unit/envVarNames.test.ts` (7 tests): multi-server, no-env,
      empty-env, invalid-JSON-yields-empty for JSON; multi-section,
      no-env_vars-line, empty-array for TOML.

## 3. `src/commands/secretsAudit.ts`

- [x] 3.1 `runSecretsAudit`/`collectSecretsAuditReport` — probes
      claude-code/codex/kiro (not pi, design.md Non-Goals), reads each
      present agent's real config file, runs both checks.
- [x] 3.2 Regression test: a literal GitLab PAT in a generated config is
      caught. Also reproduced live in the sandbox.
- [x] 3.3 Regression test: an env var name outside `allowed_vars` is
      caught even with a well-formed `${VAR}` value. Also reproduced live
      in the sandbox.
- [x] 3.4 Test: a clean config yields zero findings, exit code 0.
      Confirmed live in the sandbox against the unmodified fixture.
- [x] 3.5 Test: an absent agent contributes no findings; its file is
      never read (verified by never creating the file in that test).
- [x] 3.6 Wired into `src/cli.ts` as `trellis secrets audit`.

## 4. Sandbox fixtures and acceptance verification (sandbox only)

- [x] 4.1 `test/fixtures/home/.trellis/secrets.policy.yaml` — `SAMPLE_TOKEN`
      as the sole allowed var (matching every existing fixture agent
      config's actual declared name), plus the three reject patterns
      already established in `schema/secrets.policy.example.yaml`.
- [x] 4.2 Ran `scripts/sandbox.sh ... secrets audit` against the clean
      fixture home: `✅ no findings`, exit 0.
- [x] 4.3 Reproduced both real incidents in the sandbox against a
      container-local scratch copy (never the read-only fixture):
      renaming `SAMPLE_TOKEN` → `WRONG_TOKEN_NAME` in `.codex/config.toml`
      produced exactly the expected `unexpected-var-name` finding;
      embedding a literal `glpat-...` value in `.claude.json`'s `args`
      produced exactly the expected `literal-secret` finding. Both exited
      with code 1.
