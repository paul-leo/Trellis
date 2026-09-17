## 1. `findLiteralSecret` reports which field matched (precondition)

- [x] 1.1 `src/adapters/mcpPlan.ts`: change `findLiteralSecret`'s return
      to also carry which field the match came from (e.g. `{ label,
      field: "command" | "url" | "args" | "headers" | "staticEnv" }`
      instead of a bare label string) — scanning order stays
      `command, url, args, headers, staticEnv` (design.md D1),
      unchanged. Update `resolveMcpPlan`'s own call site (still refuses
      regardless of field — this doesn't change sync-time behavior) and
      `migrate.ts`'s call site
- [x] 1.2 `test/unit/mcpPlan.test.ts` (or sibling): `findLiteralSecret`
      reports the correct field for a match in each of the five
      locations; `resolveMcpPlan`'s own refusal behavior is unchanged
      by the shape change (existing tests still pass)

## 2. Canonical writer for the extraction (secrets.policy.yaml)

- [x] 2.1 `src/core/canonical.ts`: add
      `writeSecretsPolicyExtraction(path, { varName, envFilePath }):
      ServersYamlWriteResult`-shaped result (reuse or mirror the
      existing result type), `Document`-based like `writeMcpModeYaml`:
      sets `env_file` only if currently unset, appends `varName` to
      `allowed_vars` only if not already present (design.md D6). Same
      refusal posture as every other writer for a missing/unparseable
      file. (Also extended `forceBlockStyle` to handle a `YAMLSeq`, not
      just a `YAMLMap` — `allowed_vars: []` is a flow-style sequence in
      `trellis init`'s starter file, same underlying issue
      `writeMcpModeYaml` already had to handle for maps.)
- [x] 2.2 `test/unit/canonical.test.ts`: sets `env_file` on a policy
      file that doesn't have one yet; leaves an already-set `env_file`
      untouched; appends a new name to `allowed_vars` without disturbing
      existing entries or formatting; is a no-op (not a duplicate) when
      the name is already present; refuses on a missing file

## 3. Local secrets file writer (dotenv, idempotent)

- [x] 3.1 New function `writeLocalSecretValue` in `src/lib/secretEnv.ts`
      (colocated with `parseDotenv`/`resolveSecretEnv`, the format's
      existing owner): given a target path, a variable name, and a real
      value, returns one of `"created"`/`"already-present"`/`"conflict"`
      (design.md D4) and, only for create, performs the write —
      creating the parent directory if needed, appending a plain
      `NAME=value\n` line matching `parseDotenv`'s exact expected shape,
      no quoting/escaping. Reads the file first to decide which of the
      three outcomes applies; never blindly appends
- [x] 3.2 `test/unit/secretEnv.test.ts`: create on a not-yet-existing
      file (and its parent directory); appends without disturbing other
      entries, including when the existing file has no trailing
      newline; no-op when the same name+value is already present (no
      duplicate line); conflict (no write) when the same name has a
      different value already present; the written line round-trips
      through `parseDotenv` unchanged

## 4. `.gitignore` protection, ensured lazily

- [x] 4.1 `ensureGitignoreEntry(path, line)` in `src/core/canonical.ts`:
      given `~/.trellis/.gitignore` and the line to protect the local
      secrets file, appends the line only if missing (creates the file
      if it doesn't exist at all). Called from the extraction apply path
      (design.md D5), immediately before the first real write to the
      local secrets file — never from `trellis init`'s own bootstrap
- [x] 4.2 `test/unit/canonical.test.ts`: creates `.gitignore` with the
      right line when none exists; adds the line to an existing
      `.gitignore` without disturbing other entries; is a no-op when
      the line is already present; handles a file with no trailing
      newline

## 5. `migrate.ts`: the extraction plan action

- [x] 5.1 `src/commands/migrate.ts`: new `MigrateAction` value
      `"extract-secret"`; `MigratePlanItem` gains the fields
      `applyMigratePlan` needs (extracted var name, resolved target env
      file path — NOT the real value; design.md D9) for a `--dry-run`
      or real plan alike
- [x] 5.2 `planMcpServer`: when `findLiteralSecret` matches specifically
      in `staticEnv` (field from task 1), return the new
      `"extract-secret"` item instead of `"conflict"` — a match in any
      other field still returns `"conflict"` exactly as before
      (design.md D1, spec's ADDED "refused outside staticEnv"
      requirement). New `planStaticEnvExtraction` also handles the
      already-extracted (→ `already-migrated`) and conflicting-existing
      -value (→ `conflict`) sub-cases by reading the target env file
      read-only at plan time
- [x] 5.3 `applyMigratePlan`: for an `"extract-secret"` item, re-read
      the real value from the source definition (design.md D9 — never
      carried on the plan object itself), then: (a) ensure `.gitignore`
      protection (task 4) before the first write, (b) write the value
      via the local secrets file writer (task 3), (c) call
      `writeSecretsPolicyExtraction` (task 2), (d) upsert the
      `servers.yaml` entry with the value moved from `staticEnv` to
      `env` (name-only reference)
- [x] 5.4 `test/unit/migrate.test.ts`: a `staticEnv` literal secret
      (using this project's own real-world mcp-router shape as the
      fixture, matching the existing regression tests already added for
      the literal-secret guard — those two tests updated in place to
      assert the new `extract-secret` behavior instead of `conflict`)
      extracts successfully — canonical gains a `${NAME}` reference, the
      local secrets file gains the real value, `secrets.policy.yaml`
      gains the name in `allowed_vars`; the source agent's own fixture
      file is unchanged; re-running is idempotent (`already-migrated`,
      no duplicate/altered local secrets file); a changed value already
      in the local secrets file is a conflict, not an overwrite; an
      already-configured `env_file` is respected over the default;
      `--dry-run` never writes and never lets the real value appear in
      the plan object; a literal in `args`/`headers`/`command`/`url`
      still refuses exactly as before

## 6. Verdict and reporting

- [x] 6.1 `src/commands/onboardVerdict.ts`'s `normalizeMigrateVerdict`:
      an `"extract-secret"` item normalizes to `severity: "warning"`
      (never `blocked`), message naming the variable and where the real
      value now lives, remediation stating the source agent's own file
      was not touched and may still hold the plaintext (design.md D8)
- [x] 6.2 `printPlan` (migrate.ts, reused by onboard): already renders
      any action (including `"extract-secret"`) distinctly by
      interpolating it into the printed label, and `detail`/`remediation`
      never carry the real value by construction (design.md D9) — no
      code change needed; verified directly by printing a real
      extraction plan and confirming the token never appears in either
      the printed text or `JSON.stringify(plan)`
- [x] 6.3 `test/unit/onboardVerdict.test.ts` +
      `test/unit/onboard.test.ts`: an extraction normalizes to
      `severity: "warning"` with a remediation naming the variable and
      that the source file wasn't touched; at the onboard level, an
      extraction reaches `result.verdict` as a `warning`, not `blocked`;
      the run's exit code is zero when extraction is the only finding;
      `--json` output never contains the real value in any field

## 7. Documentation

- [x] 7.1 `docs/getting-started.md`: document the extraction behavior —
      what triggers it, where the local secrets file lives by default,
      that it's git-ignored automatically, and that the source agent's
      own file is never touched
- [x] 7.2 `docs/roadmap.md`: this change's entry once implemented (P24)

## 8. Full-suite verification

- [x] 8.1 Full project-wide test suite passes with zero regressions
      (594/594)
- [x] 8.2 Typecheck and build succeed
- [x] 8.3 A real `trellis migrate --from claude-code --only mcp
      --dry-run` against a scratch home with a fixture (not real)
      mcp-router shape, run against the built `dist/cli.js`: previews
      the extraction, exits 0, writes nothing (`servers.yaml` unchanged,
      no `servers.local.env` created). Also ran a real (non-dry-run)
      pass in the same scratch setup as extra confidence beyond unit
      tests: `servers.yaml` correctly gained `env: [MCPR_TOKEN]` (never
      the literal), `servers.local.env`/`secrets.policy.yaml`/
      `.gitignore` all came out exactly as designed, the source
      `.claude.json` fixture was byte-for-byte unchanged, and a second
      run reported `already-migrated`
- [x] 8.4 **Requires explicit user confirmation before running** — this
      step touches a real, live credential and this machine's actual
      `~/.trellis/`: a real (non-`--dry-run`) `trellis migrate --from
      kiro --only mcp` actually extracts the real `mcp-router` token
      into `~/.trellis/mcp/servers.local.env`, `servers.yaml` gains a
      `${MCPR_TOKEN}` reference, `secrets.policy.yaml` gains the name,
      `~/.trellis/.gitignore` protects the new file, and kiro's own
      `~/.kiro/settings/mcp.json` is confirmed byte-for-byte unchanged
      afterward. Confirmed on the real machine: `servers.yaml`'s
      `mcp-router` entry now reads `env: [MCPR_TOKEN]` with no literal;
      `servers.local.env` holds the real value (redacted from repository
      documentation);
      `secrets.policy.yaml` gained `env_file:
      ~/.trellis/mcp/servers.local.env` and `MCPR_TOKEN` in
      `allowed_vars`; `~/.trellis/.gitignore` gained
      `mcp/servers.local.env`; kiro's `~/.kiro/settings/mcp.json` md5
      unchanged (`e7800a4b832d7ff8aa5c8663556d1325`)

## 9. Shell rc wiring so the `${VAR}` reference actually resolves (D10)

- [x] 9.1 `src/core/canonical.ts`: `ensureShellEnvSource(rcPath,
      envFilePath)` — idempotent marker-block append (mirrors D5's
      `ensureGitignoreEntry`), never writes a literal secret value, only
      the env file's path
- [x] 9.2 `src/commands/migrate.ts`: `defaultShellRcPath(homeDir)` picks
      the rc file from `$SHELL`; `applyMigratePlan` calls
      `ensureShellEnvSource` once per invocation whenever
      `secretsPolicy.envFile` is set — not gated on a fresh extraction,
      so an already-extracted machine gets retroactively wired the next
      time migrate runs at all
- [x] 9.3 `test/unit/canonical.test.ts` (5 tests) +
      `test/unit/migrate.test.ts` (2 tests): creates/appends/no-ops the
      rc block correctly, never leaks the real value into the rc file,
      wires on a fresh extraction, and retroactively wires on a re-run
      with nothing new to extract
- [x] 9.4 **Fixed a real, separate incident found while building this**:
      `trellis mcp sync --help` had no `--help`/`-h` handling in any
      subcommand branch (only the top-level `trellis --help`) — a stray
      `--help` silently ran the real, non-dry-run command instead of
      printing usage. `src/cli.ts` now short-circuits to `printUsage()`
      whenever `--help`/`-h` appears anywhere in a subcommand's own args,
      before any parsing or real action
- [x] 9.5 **Requires explicit user confirmation before running** — real
      (non-`--dry-run`) `trellis migrate --from kiro --only mcp` on this
      actual machine: confirms `~/.zshrc` gains the source block pointing
      at `~/.trellis/mcp/servers.local.env`, kiro's/claude-code's/codex's
      native configs actually resolve `${MCPR_TOKEN}` once the current
      shell/agent picks up the new environment variable (may require a
      new shell session or restarting the agent process to take effect).
      Confirmed on the real machine: dry-run wrote nothing; the real run
      reported `already-migrated` for every server (nothing new to
      extract) yet still appended the block to `~/.zshrc` — all 100
      pre-existing lines preserved untouched, the real token confirmed
      absent from the file. Still outstanding (not automatable by
      `migrate` itself): a new shell session / restarting
      codex/kiro/claude-code is what actually makes each process pick up
      `MCPR_TOKEN` from the now-updated environment

## 10. Accept command/url/args/headers literals, TRELLIS_-prefixed staticEnv naming (D11)

- [x] 10.1 Investigated whether `${VAR}` resolution is proven for
      `command`/`url`/`args`/`headers` across every consumer
      (`mcpConnect.ts`, `jsonMcp.ts`, `tomlSection.ts`) — found none
      proven for `url`/`args`/`command` anywhere, and `headers`
      unverified for claude-code/kiro specifically (only pi-bridge and
      Codex's narrow `Bearer ${VAR}` carve-out are proven) — ruled out
      synthesizing a name + writing a reference for any of the four
- [x] 10.2 `src/adapters/mcpPlan.ts`'s `resolveMcpPlan` (sync-OUT) and
      `src/commands/migrate.ts`'s `planMcpServer` (migrate-IN): only a
      `staticEnv` match still refuses/extracts — a match in
      `command`/`url`/`args`/`headers` is accepted as ordinary literal
      config on both boundaries, exactly as if no match were found
- [x] 10.3 `synthesizeVarName(server, key)` → `TRELLIS_<SERVER>_<KEY>`
      (`src/commands/migrate.ts`) for NEW `staticEnv` extractions;
      `planStaticEnvExtraction`'s already-migrated check now looks up
      `existing.env` **by value** (any referenced name whose
      local-secrets value already matches) instead of recomputing
      today's naming scheme — keeps an extraction from before this
      scheme existed (this project's own real `mcp-router`) working
      without renaming it
- [x] 10.4 `src/commands/secretsAudit.ts`: new `auditCanonicalServersYaml`
      scans `~/.trellis/mcp/servers.yaml` itself against
      `reject_patterns` (literal-secret check only), findings carry
      `agent: "canonical"` — so accepting a literal into canonical is
      never silent
- [x] 10.5 Tests: `mcpPlan.test.ts`/`mcp.test.ts` updated + new tests for
      accept-not-refuse on `args`/`headers`/`command`, staticEnv refusal
      unaffected; `migrate.test.ts` updated for the new `TRELLIS_` name
      plus a dedicated backward-compat test (pre-seeded bare-name
      reference recognized as already-migrated, no duplicate reference
      created); `secretsAudit.test.ts` new tests for the canonical scan.
      606/606 full suite passing
- [x] 10.6 Real-machine verification: `migrate --from kiro --only mcp
      --dry-run` against this actual machine still reports
      `already-migrated` for `mcp-router` (bare `MCPR_TOKEN` name,
      predates this scheme) — confirmed the naming-scheme change does
      not disturb the already-working real extraction
- [x] 10.7 `design.md` D11, `specs/canonical-source-migration/spec.md`
      updated (the "refuse outside staticEnv" requirement rewritten to
      "accepted as ordinary config", new naming-scheme requirement text
      and a by-value backward-compat scenario)
