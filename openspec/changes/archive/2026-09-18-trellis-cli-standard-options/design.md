# Design

## Goals / Non-Goals

**Goals:**

- Make the installed Trellis version observable with one conventional command.
- Ensure help/version paths never run a mutating command.
- Avoid breaking pass-through semantics for the `kimi` launcher.
- Read the version from the package metadata so the CLI and published package
  cannot silently drift.

**Non-Goals:**

- Do not introduce a new argument-parsing dependency.
- Do not redesign each command's detailed help text in this change.
- Do not intercept flags passed through to Kimi.

## Decisions

### D1 — Version source is the adjacent package manifest

Load `../package.json` relative to the compiled CLI entrypoint. This resolves
to the repository manifest in source/tsx execution and to the published
package manifest after installation. The command prints only the semver value
to keep the output script-friendly.

### D2 — Help aliases are handled before command dispatch

`trellis`, `trellis --help`, `trellis -h`, and `trellis help` print the
existing usage text and return successfully. A help flag anywhere in a normal
Trellis command's arguments also short-circuits before business logic, keeping
the existing safety guarantee for nested commands.

### D3 — Kimi is an explicit pass-through boundary

The `kimi` subcommand forwards all remaining arguments to the Kimi binary.
Therefore generic nested `--help`/`--version` interception is skipped for
that branch. Trellis version remains available as `trellis --version`.

### D4 — Unknown options remain errors

This change does not make arbitrary flags valid or silently ignore malformed
arguments. Existing command-specific validation and exit codes remain intact.

## Verification

- Source CLI: `--version`, `-v`, `help`, `--help`, `-h`.
- Nested help: `mcp sync --help` must not perform sync.
- Kimi pass-through: `kimi --version` reaches the Kimi launcher.
- Built CLI and package tarball expose the same version.
