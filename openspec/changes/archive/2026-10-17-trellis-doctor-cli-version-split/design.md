# Design

## Context

- `runDoctor` (src/commands/doctor.ts) calls `collectDoctorReport`, computes the exit code from `report.findings` against `EXIT_NONZERO_KINDS`, then prints.
- `collectDoctorReport` is called directly by many unit tests with a scratch HOME. It already spawns real agent probes but never `trellis` itself.
- Real incident: three entrypoints existed (`~/.volta/tools/image/node/22.22.1/bin/trellis` 0.16.0, `~/.volta/bin/trellis` volta shim 0.12.0, `~/.local/bin/trellis` sh wrapper 0.12.0). Only one was upgraded; the interactive shell ran the wrapper.

## Goals / Non-Goals

**Goals:**
- Make a version split visible in one `trellis doctor` run, with the path that actually wins.
- Keep it read-only and cheap.

**Non-Goals:**
- Fixing the split, or advising per-manager commands (volta vs npm vs bun).
- Parsing wrapper script contents. A wrapper may legitimately route subcommands elsewhere.
- Checking entries outside `PATH`.

## Decisions

### D1: Detection lives in `src/lib/cliEntrypoints.ts`, invoked from `runDoctor`

Not from `collectDoctorReport`. Spawning `trellis --version` several times inside every library-level call would slow unit tests and make any test asserting "no findings" depend on the developer's real PATH. `runDoctor` is the CLI boundary, so the real-machine check belongs there. The module takes `{ pathEnv, execVersion }` so tests inject a fake PATH and fake executor.

Consequence: `--json` output includes the finding (it is pushed into `report.findings` before printing) while direct `collectDoctorReport` callers are unaffected.

### D2: Version comes from running `--version`, not from reading files

A wrapper script has no version of its own; only executing it reveals which package it forwards to, which is exactly the fact that matters. Each execution uses a 5 s timeout and `execFileSync` with an argv array (no shell string). Output is matched with `\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`; the first match wins.

### D3: De-duplicate by realpath, preserve PATH order

`fs.realpathSync` on each candidate; first occurrence wins. A volta shim is a symlink to the shared `volta-shim` binary, so de-duplicating on the resolved target is only used to drop true duplicates of the same path entry; distinct shim names stay distinct because the *spawned* path is the original, not the target. Only regular files with an executable bit count.

### D4: Non-zero exit, new kind `cli-version-split`

A stale binary that wins on PATH silently changes behavior (schema validation here). That is drift in the same sense as the existing kinds, so it joins `EXIT_NONZERO_KINDS`.

### D5: Unrunnable entries are skipped

A broken entry should not produce a false "split". If every entry fails, nothing is reported.

## Risks / Trade-offs

- Spawning wrappers executes user scripts (here `probe-budget` preload). `--version` is the lowest-impact invocation and the user's own PATH already executes these on every use. Accepted.
- A deliberate two-version setup (pinned CI copy) becomes an exit-1 doctor. Mitigation is out of scope; the finding text names the winner so it is easy to judge.
- ~3 extra short process spawns per doctor run. Negligible next to the agent probes.
