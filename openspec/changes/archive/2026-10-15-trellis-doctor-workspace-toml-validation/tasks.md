# Tasks

## 1. Dependency and finding kind

- [x] 1.1 Add `smol-toml` to `dependencies` in `package.json` and update the lockfile. Verify with `npm ls smol-toml` showing a resolved version and `npm run typecheck` still clean.
- [x] 1.2 Add `"workspace-toml-invalid"` to `FindingKind` in `src/commands/doctor.ts` and add it to `EXIT_NONZERO_KINDS`. Verify by `npm run typecheck` and by confirming the existing doctor test suite still passes (no behavior change yet — nothing produces the new kind).

## 2. Workspace TOML validation in the doctor collector

- [x] 2.1 In `src/lib/workspaceDoctor.ts`, change the Codex branch of `unmarkedEntries` to first attempt a `smol-toml` parse of the file. On success, fall through to the existing regex header extraction unchanged. On failure, return a discriminated result `{ kind: "invalid-toml", line, column, reason }` (adjust the function's return type accordingly). Verify with a new unit test that feeds a duplicate-key TOML and asserts the invalid-toml result, and a second test feeding valid TOML that asserts the existing extraction output is byte-identical to before this change.
- [x] 2.2 In `collectWorkspaceDoctorSection`, consume the new result: files whose extraction returned `invalid-toml` are omitted from the `unmigrated` list and instead surface one entry in a new `workspaceTomlFindings: Finding[]` field on `WorkspaceDoctorSection`, with `kind: "workspace-toml-invalid"`, `agent: "codex"`, and a message naming the file, parser line/column, and reason, plus remediation "not rendered by Trellis — fix by hand and re-run `trellis doctor`". Verify with unit tests for (a) broken file produces exactly one such finding and no unmigrated hint for that file, (b) clean file produces an empty `workspaceTomlFindings` and unchanged unmigrated behavior.

## 3. Doctor command wiring

- [x] 3.1 In `src/commands/doctor.ts`, extend the workspace-section renderer (both human table and `--json` output) to include `workspaceTomlFindings` rows, following the existing finding-row format (⚠️ / message). Verify with a doctor-level test asserting table output contains the file path and "duplicate key" for a fixture workspace, and `--json` output includes the finding under the workspace section.
- [x] 3.2 Change the workspace-section gate in `runDoctor` from `canonical?.workspace` to "a workspace root is discoverable from cwd" (via `findWorkspaceRoot`), building a minimal canonical source when the global one is absent so `collectWorkspaceDoctorSection` still runs. Verify with a test that runs `runDoctor` in a temp HOME (no `~/.trellis/`) whose cwd is a temp workspace with only `.agents/skills/` and a broken `.codex/config.toml`, asserting the workspace TOML finding appears.

## 4. End-to-end and quality gates

- [x] 4.1 Run `npm test` for the doctor and workspaceDoctor suites; then the full test suite. All green.
- [x] 4.2 Run `npm run typecheck` and `npm run build`. Both clean.
- [x] 4.3 Sandbox verification on a temp HOME (per repo's real-config rule): create a temp workspace with `.agents/skills/` and a `.codex/config.toml` containing a duplicate `enabled` key, run the built `trellis doctor`, assert exit code is non-zero and output names the file and parser line/column. Then fix the file by hand (delete one duplicate line) and re-run, asserting exit code 0.
- [x] 4.4 Run `openspec validate trellis-doctor-workspace-toml-validation --strict` and confirm it passes.
