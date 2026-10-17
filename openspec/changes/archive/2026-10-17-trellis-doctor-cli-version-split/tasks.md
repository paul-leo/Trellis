# Tasks

## 1. Detection module

- [x] 1.1 Create `src/lib/cliEntrypoints.ts` exporting `findCliEntrypoints({ pathEnv, execVersion })` returning `{ path, version }[]` in PATH order, de-duplicated by realpath, executable regular files only, entries whose version cannot be determined omitted. Verify with unit tests: ordering, symlink de-dup, non-executable skipped, unrunnable entry skipped.
- [x] 1.2 Export `detectCliVersionSplit(entries)` returning a `Finding`-shaped result or `undefined`: none for 0 or 1 entries or all-equal versions; otherwise a message listing every path and version, marking the first as the one that runs. Verify with unit tests for the five spec scenarios.

## 2. Doctor wiring

- [x] 2.1 Add `"cli-version-split"` to `FindingKind` and `EXIT_NONZERO_KINDS` in `src/commands/doctor.ts`. Verify with `npm run typecheck`.
- [x] 2.2 In `runDoctor`, call the detector with the real `PATH` and a 5 s `execFileSync` executor, push any finding into `report.findings` before the exit code is computed and before printing. Verify with a test that injects a fake PATH of two stub scripts with different versions and asserts exit 1 and the finding in `--json`; and a test with identical versions asserting exit 0.

## 3. Quality gates and release

- [x] 3.1 Run `npm test`, `npm run typecheck`, `npm run build`. All clean.
- [x] 3.2 Sandbox check with the built CLI: PATH with two stub `trellis` scripts (0.1.0 and 0.2.0) yields exit 1 and the finding; with equal versions yields exit 0. The user's real wrapper is not touched.
- [x] 3.3 `openspec validate trellis-doctor-cli-version-split --strict` passes; archive and sync the delta into `openspec/specs/capability-drift-detection/spec.md`.
- [ ] 3.4 Bump to 0.17.0, commit, push, `npm publish`, confirm with `npm view agent-trellis@0.17.0 version` and the packument `time` entry.
