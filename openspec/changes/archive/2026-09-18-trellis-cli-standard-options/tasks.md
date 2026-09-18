# Tasks

## 1. CLI metadata and dispatch

- [x] 1.1 Add a package-relative version loader and expose the package version
      from the CLI.
- [x] 1.2 Implement `--version`/`-v` and `help` while preserving existing
      `--help`/`-h` behavior and Kimi argument forwarding.

## 2. Verification

- [x] 2.1 Add process-level CLI tests for version/help aliases, nested help,
      side-effect safety, and Kimi pass-through.
- [x] 2.2 Run tests, typecheck, build, package verification, and strict
      OpenSpec validation; verify the installed package manually.
