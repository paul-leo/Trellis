# Spec Delta

## Purpose

Provide predictable, side-effect-free version and help entry points so users
can identify the installed Trellis build and discover commands safely.

## ADDED Requirements

### Requirement: Trellis exposes its installed version

The CLI SHALL print the version declared by the installed Trellis package when
invoked with `trellis --version` or `trellis -v`, and SHALL exit successfully
without reading or modifying Trellis user state.

#### Scenario: Long version flag

- **WHEN** a user runs `trellis --version`
- **THEN** the process prints the package semver and exits with code 0

#### Scenario: Short version flag

- **WHEN** a user runs `trellis -v`
- **THEN** the process prints the same package semver and exits with code 0

### Requirement: Trellis exposes safe help aliases

The CLI SHALL print its usage information and exit successfully for
`trellis`, `trellis help`, `trellis --help`, and `trellis -h`.

#### Scenario: Bare command help

- **WHEN** a user runs `trellis` or `trellis help`
- **THEN** the process prints usage information and exits with code 0

#### Scenario: Flag help

- **WHEN** a user runs `trellis --help` or `trellis -h`
- **THEN** the process prints usage information and exits with code 0

### Requirement: Nested help never executes the requested operation

The CLI SHALL treat `--help` and `-h` in a normal Trellis command's argument
list as a help request before dispatching any mutating or external operation.

#### Scenario: MCP sync help

- **WHEN** a user runs `trellis mcp sync --help`
- **THEN** usage information is printed and MCP synchronization is not run

### Requirement: Kimi arguments remain pass-through

The CLI SHALL forward arguments after `trellis kimi` to Kimi without Trellis
intercepting Kimi's own `--help` or `--version` flags.

#### Scenario: Kimi version pass-through

- **WHEN** a user runs `trellis kimi --version`
- **THEN** the Kimi launcher receives `--version` unchanged
