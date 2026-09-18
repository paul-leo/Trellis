# Proposal

## Why

The packaged CLI currently exposes help through `--help`/`-h`, but the
top-level `--version`/`-v` contract is missing. That makes it difficult to
verify which locally installed Trellis build is actually running and is
especially confusing when a Volta or npm global installation is involved.

## What Changes

- Add top-level `trellis --version` and `trellis -v` output from the package's
  own `package.json` version.
- Add a `trellis help` command as an alias for top-level help.
- Preserve `--help`/`-h` as side-effect-free help paths, including nested
  command invocations such as `trellis mcp sync --help`.
- Keep `trellis kimi` arguments pass-through, so `trellis kimi --help` and
  `trellis kimi --version` continue to address Kimi rather than Trellis.
- Add process-level tests for the packaged/source CLI behavior and verify the
  built package.

## Capabilities

### New Capabilities

- `cli-standard-options`: conventional version and help entry points with no
  configuration or state mutation.

### Modified Capabilities

- None.

## Impact

- `src/cli.ts` and a small package-version loader.
- CLI process tests and package verification.
- No changes to onboarding, agent state, MCP, Skill, memory, or credentials.
