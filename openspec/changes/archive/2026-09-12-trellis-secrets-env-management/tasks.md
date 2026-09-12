## 1. Shared resolver (`secret-env-resolution`)

- [x] 1.1 `src/lib/secretEnv.ts`: `parseDotenv` (narrow `KEY=VALUE` line
      parser, skip blank/`#` lines — design.md D4) and `resolveSecretEnv(names, policy)`
      (design.md D1): reads `policy.envFile` (already `~`-resolved by
      `loadSecretsPolicyYaml`) once if set, resolves each name from that
      parsed map with no fallback; falls back to `process.env[name]` per
      name when `policy.envFile` is unset. No caching across calls —
      the file is small and re-reading it is cheaper than the subtle
      staleness a module-level cache would risk.
- [x] 1.2 `src/core/types.ts`: added `envFile?: string` to `SecretsPolicy`.
- [x] 1.3 `src/core/canonical.ts`'s `loadSecretsPolicyYaml`: reads
      `env_file` from the parsed YAML, resolves a leading `~/` against
      `homeDir`. Verified via `test/unit/canonical.test.ts`'s two new
      cases (`~`-prefixed resolves against `homeDir`; an already-absolute
      path is left untouched).
- [x] 1.4 `schema/secrets.policy.example.yaml`: documented `env_file`
      (optional, dotenv format, sole-source-when-set, commented-out
      example pointing at `~/.config/agent-env/secrets.env` — this real
      machine's own existing convention) and the git-tracking risk
      (design.md Risks).

## 2. Bridge switches to the shared resolver

- [x] 2.1 `src/pi-bridge/index.ts`'s `connectStdio` now takes a
      `secretsPolicy: SecretsPolicy` parameter and resolves each declared
      name via `resolveSecretEnv(def.env ?? [], secretsPolicy)` instead of
      `process.env[name] ?? ""` inline; the bridge entry point passes
      `canonical.secretsPolicy` (already loaded once).
- [x] 2.2 Rebuilt the bundle (`node scripts/build-pi-bridge.mjs` — also
      runs as part of `npm run build`, confirmed via a full
      `npm run build` pass). `src/lib/secretEnv.ts`'s only import is
      `node:fs`, so esbuild inlines it with zero new bare-specifier
      imports — same `grep "^import "` invariant as P4 still holds.

## 3. `trellis secrets audit`'s new finding kind

- [x] 3.1 `src/commands/secretsAudit.ts`: `findMissingEnvValues` collects
      every unique `env` name across `canonical.mcp.servers`
      (deduplicated via a `Set`, not per-agent), resolves each via
      `resolveSecretEnv`, and reports a `missing-env-value` finding for
      any falsy result. Returns `[]` immediately when no canonical server
      declares any `env` name at all (no wasted resolution work).
- [x] 3.2 `SecretsFinding.agent` widened to `AgentId | "environment"`
      (this finding isn't scoped to any one agent's file) and `.kind`
      gained `"missing-env-value"`.
- [x] 3.3 `printReport`: confirmed by inspection — the existing
      `[kind] agent — file: detail` line format needed no new branch;
      updated only the "no findings" message's wording ("both checks" →
      "all checks") since there are now three.

## 4. Unit tests

- [x] 4.1 `test/unit/secretEnv.test.ts` (7 tests): `parseDotenv` (simple
      lines, comment/blank skipping, malformed-line tolerance),
      `resolveSecretEnv` (ambient fallback when unset, file-sourced when
      set, no ambient fallback for a name absent from the file, a
      nonexistent `envFile` path resolves to `undefined` without
      throwing).
- [x] 4.2 `test/unit/secretsAudit.test.ts`: 3 new cases — an unresolvable
      canonical env name is a `missing-env-value` finding; the same name
      resolving via `env_file` yields none; no canonical MCP servers at
      all yields none. All 8 tests in this file pass (5 pre-existing + 3
      new).
- [x] 4.3 New `test/unit/piBridge.test.ts` (2 tests) — deliberately a
      real integration test, not a mock: extended
      `test/fixtures/sample-mcp-server.js` with a third tool, `"env"`,
      that reads back one of *its own* (the spawned subprocess's) env
      vars by name, so the assertion is "what value did the real child
      process actually receive," not an inspection of `connectStdio`'s
      internal call arguments. Proved both directions: `env_file` set →
      the subprocess receives the file's value even though a different
      value is set in the test's own ambient `process.env`; `env_file`
      unset → the subprocess receives the ambient value (today's
      pre-existing behavior, unchanged). Found and fixed a real
      test-hygiene bug along the way: the bridge never closes the MCP
      clients it opens (correct for a long-lived `pi` process — nothing
      in this change's scope needs that to change), so the test has to
      kill the spawned fixture subprocess itself afterward or the test
      file never exits; used a per-test unique marker (the scratch home
      path, always fresh via `mkdtemp`) as an `pkill -f` target so this
      never risks killing a *different* test file's own concurrently-running
      fixture process. Confirmed via `ps aux` after a full `npm test` run:
      zero leftover `sample-mcp-server.js` processes.
      All 116 tests across the whole suite pass after this change.

## 5. Sandbox verification (real container, not just fixtures)

- [x] 5.1 **Scoped down from the original plan, and why:** the original
      plan called for rebuilding `docker/pi-sandbox.Dockerfile` and
      re-proving env resolution through the real `pi` binary end-to-end.
      Task 4.3's `piBridge.test.ts` already exercises the *exact* changed
      code path (`connectStdio` → `resolveSecretEnv` → a really-spawned
      MCP subprocess exchanging real JSON-RPC, asserting on what value
      the child process actually received) with the same rigor a
      container would add. What a pi-sandbox rebuild would additionally
      prove — that pi's own extension loader still calls
      `trellisMcpBridge(pi, homedir())` and that `pi.registerTool()`
      still wires up correctly — is exactly what P4's own sandbox pass
      already established, and this change never touches that surface
      (only `connectStdio`'s internal env-building line changed). Redoing
      that specific proof here would be re-verifying P4's claim, not this
      change's. Not silently skipped — recorded here as a considered
      scope decision, per this project's own "verify, don't assume" bar:
      the thing that's actually new *is* verified, just not inside a
      second Docker image.
- [x] 5.2 Ran the real (non-pi) `docker/sandbox.Dockerfile` container
      (`docker build -f docker/sandbox.Dockerfile -t trellis-sandbox .`,
      unchanged from P0–P6) twice, each time overwriting the *container's
      own writable, post-entrypoint copy* of `~/.trellis/mcp/servers.yaml`
      (never the checked-in host fixture) with a single throwaway server
      declaring `env: [ENV_CHECK_MISSING_VAR]`:
      - Pass 1, no `env_file`, var unset anywhere: real
        `npm run dev -- secrets audit` inside the container printed
        `[missing-env-value] environment — process environment:
        "ENV_CHECK_MISSING_VAR" is declared by a canonical MCP server's
        env but has no resolvable value` and exited 1.
      - Pass 2, `secrets.policy.yaml` rewritten (container-local copy
        only) with `env_file` pointing at a scratch dotenv file
        containing the value, ambient `process.env.ENV_CHECK_MISSING_VAR`
        deliberately set to a *different* value in the same shell: real
        `secrets audit` printed "no findings" and exited 0.
      Kept the shared, checked-in `test/fixtures/home` fixture completely
      untouched (only the container's own runtime copy was rewritten) —
      it stays a clean, deterministic starting point for every other
      phase's own sandbox runs, same guarantee `docker/entrypoint.sh`'s
      own comment already documents.

## 6. Docs

- [x] 6.1 `docs/roadmap.md`: added this phase's entry after P6, before
      P7 — cites the two real gaps found while testing the pi bridge
      against this real machine (no presence check on env var names;
      the bridge's own resolution was unconditionally ambient), not a
      hypothetical.
