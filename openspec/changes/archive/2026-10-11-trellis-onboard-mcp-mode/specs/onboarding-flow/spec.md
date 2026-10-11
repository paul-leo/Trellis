# onboarding-flow Specification (delta)

## ADDED Requirements

### Requirement: MCP mode is resolved once per run, unchanged unless explicitly requested

The system SHALL support `--mcp-mode <direct|hub|gateway>` on `trellis
onboard`, with `--hub-url <url>` required when `--mcp-mode hub` is given
and `--gateway-agents <ids>` optional when `--mcp-mode gateway` is given
(omitted meaning every managed agent). When `--mcp-mode` is omitted
entirely, the run SHALL leave the mode already recorded in canonical
untouched and SHALL NOT prompt for one — this SHALL hold identically
whether canonical currently has no mode configured (a first run) or an
already-configured one (a later run), so that omitting the flag has one
consistent meaning regardless of which run this is.

Setting a mode SHALL be mutually exclusive with the other two: selecting
`hub` SHALL clear any existing `gateway` configuration and selecting
`gateway` SHALL clear any existing `hub` configuration; selecting
`direct` SHALL clear both.

`--hub-url` or `--gateway-agents` given without their matching
`--mcp-mode` value, or `--mcp-mode hub` given without `--hub-url`, SHALL
refuse the entire run rather than silently ignoring the flag or falling
back to a default.

#### Scenario: Omitting the flag on a fresh machine preserves the default
- **WHEN** `trellis onboard` runs with no `--mcp-mode` against a home
  where `servers.yaml` has no `hub`/`gateway` keys
- **THEN** the run proceeds in direct mode, unchanged, and no `hub`/
  `gateway` key is written

#### Scenario: Omitting the flag on a later run preserves what's already set
- **WHEN** `trellis onboard` runs with no `--mcp-mode` against a home
  where `servers.yaml` already has `gateway: { enabled: true }` from an
  earlier run
- **THEN** the run proceeds with gateway mode unchanged, and no write to
  `hub`/`gateway` occurs

#### Scenario: `--mcp-mode gateway` enables gateway mode for every managed agent
- **WHEN** `trellis onboard --mcp-mode gateway` runs with no
  `--gateway-agents`
- **THEN** `servers.yaml` is written with `gateway: { enabled: true }`
  and no `agents` key, and any existing `hub` key is removed

#### Scenario: `--mcp-mode gateway --gateway-agents` narrows to specific agents
- **WHEN** `trellis onboard --mcp-mode gateway --gateway-agents
  codex,pi` runs
- **THEN** `servers.yaml`'s `gateway.agents` is written as exactly
  `[codex, pi]`

#### Scenario: `--mcp-mode hub` without `--hub-url` refuses cleanly
- **WHEN** `trellis onboard --mcp-mode hub` runs with no `--hub-url`
- **THEN** the command refuses before writing anything, naming
  `--hub-url` as required

#### Scenario: `--mcp-mode hub --hub-url` writes the hub entry and clears gateway
- **WHEN** `trellis onboard --mcp-mode hub --hub-url
  https://hub.example.com` runs against a home with an existing
  `gateway: { enabled: true }`
- **THEN** `servers.yaml` is written with `hub: { url:
  https://hub.example.com }` and the `gateway` key is removed

#### Scenario: `--mcp-mode direct` clears both hub and gateway
- **WHEN** `trellis onboard --mcp-mode direct` runs against a home with
  an existing `hub` key
- **THEN** `servers.yaml`'s `hub` key is removed and no `gateway` key is
  written

#### Scenario: A stray mode-specific flag without its mode refuses
- **WHEN** `trellis onboard --hub-url https://hub.example.com` runs with
  no `--mcp-mode`
- **THEN** the command refuses rather than silently ignoring `--hub-url`

### Requirement: MCP mode changes go through Trellis's own writer, never hand-edited

The system SHALL provide a canonical writer for the top-level `hub`/
`gateway` keys in `servers.yaml` that preserves every other key's
existing formatting, matching the guarantee `upsertServerYaml` already
provides for individual server entries. The writer SHALL refuse (no
write) if `servers.yaml` does not exist or fails to parse, matching
`upsertServerYaml`'s existing refusal posture.

#### Scenario: An unrelated hand-authored comment survives a mode change
- **WHEN** `servers.yaml` has a comment above its `servers:` key and
  `trellis onboard --mcp-mode gateway` runs
- **THEN** the comment is still present afterward, unchanged

#### Scenario: A missing servers.yaml refuses instead of creating one implicitly
- **WHEN** `--mcp-mode` is given against a home where `~/.trellis/mcp/
  servers.yaml` does not exist
- **THEN** the command refuses, naming `trellis init` as the next step,
  the same message shape `upsertServerYaml` already produces for a
  missing file

### Requirement: The resolved MCP mode is reported without requiring a prompt

The system SHALL, on a non-`--json` run with stdout a real terminal,
print the mode the run resolved to and, when `--mcp-mode` was not given,
name the flag that would change it — informational only, never a
prompt requiring a keystroke to proceed. `--json` output SHALL include
the resolved mode and whether this run changed it, additively, with no
existing field changing meaning.

#### Scenario: An unchanged run still states the mode
- **WHEN** `trellis onboard` runs interactively with no `--mcp-mode`
- **THEN** the output includes a line stating the current mode and that
  `--mcp-mode` is how to change it, without waiting for any input

#### Scenario: A changed run states what changed
- **WHEN** `trellis onboard --mcp-mode gateway` runs against a home
  previously in direct mode
- **THEN** the output states the mode changed from direct to gateway

#### Scenario: `--json` exposes the resolved mode structurally
- **WHEN** `trellis onboard --mcp-mode hub --hub-url
  https://hub.example.com --json` runs
- **THEN** the JSON output includes the resolved mode and `changed:
  true`, alongside every field `--json` already produced before this
  change

#### Scenario: Non-interactive runs print no status line
- **WHEN** `--json` is set, or stdout is not a TTY
- **THEN** no mode status line is printed to stdout

### Requirement: The shared memory server is toggled once per run, unchanged unless explicitly requested

The system SHALL support `--memory <on|off>` on `trellis onboard`. When
omitted, the run SHALL leave `mcp.servers["memory"]` exactly as canonical
already has it — absent on a machine where it was never configured,
present on one where it already was — and SHALL NOT prompt for it,
identically on a first run and a later one.

`--memory on` SHALL write the default memory server definition
(`@modelcontextprotocol/server-memory`, with `static_env.MEMORY_FILE_PATH`
set) unless `"memory"` already exists in `mcp.servers` (a no-op) or
`"memory"` is listed in `known_host_injected`, in which case the run
SHALL refuse rather than write a definition that a later `mcp sync` would
refuse to propagate to any agent. `--memory off` SHALL remove the
`"memory"` entry from `servers.yaml` if present, and SHALL be a no-op if
it is already absent.

This resolution SHALL run before onboard's own `mcp sync` and `memory
sync` stages in the same run, so that enabling memory, syncing it to
every managed agent's native config, and populating it from canonical
`memories/*.md` all complete within one `trellis onboard --memory on`
run.

#### Scenario: Omitting the flag on a fresh machine leaves memory unconfigured
- **WHEN** `trellis onboard` runs with no `--memory` against a home
  where `servers.yaml` has no `"memory"` entry
- **THEN** the run proceeds with no memory server configured, and no
  write to `servers.yaml` occurs for it

#### Scenario: Omitting the flag on a later run preserves an already-enabled memory server
- **WHEN** `trellis onboard` runs with no `--memory` against a home where
  `servers.yaml` already has a `"memory"` entry from an earlier run
- **THEN** the run proceeds with that entry unchanged, and no write is
  attempted

#### Scenario: `--memory on` enables the default server and it reaches every agent in the same run
- **WHEN** `trellis onboard --memory on` runs against a home with no
  `"memory"` entry and no `"memory"` in `known_host_injected`
- **THEN** `servers.yaml` gains a `"memory"` entry with
  `static_env.MEMORY_FILE_PATH` set, and the same run's `mcp sync` stage
  writes it into every managed agent's native config

#### Scenario: `--memory on` populates the graph from canonical memories in the same run
- **WHEN** `trellis onboard --memory on` runs against a home with at
  least one file under `~/.trellis/memories/` and no prior `"memory"`
  entry
- **THEN** the same run's `memory sync` stage — previously a no-op on
  this home for lack of a configured server — writes that content into
  the graph file

#### Scenario: `--memory on` refuses when a host already injects a memory connector
- **WHEN** `trellis onboard --memory on` runs against a home where
  `known_host_injected` already lists `"memory"`
- **THEN** the command refuses before writing anything, explaining that a
  host on this machine is presumed to already inject a memory connector
  under that name

#### Scenario: `--memory off` removes an existing entry
- **WHEN** `trellis onboard --memory off` runs against a home with an
  existing `"memory"` entry
- **THEN** `servers.yaml`'s `"memory"` entry is removed

#### Scenario: `--memory off` on an already-absent entry is a no-op, not an error
- **WHEN** `trellis onboard --memory off` runs against a home with no
  `"memory"` entry
- **THEN** the run completes with `changed: false` and no write is
  attempted

#### Scenario: A TTY run states the memory status without prompting
- **WHEN** `trellis onboard` runs interactively with no `--memory`
- **THEN** the output includes a line stating whether memory is on or
  off and that `--memory` is how to change it, without waiting for any
  input

#### Scenario: `--json` exposes the resolved memory state structurally
- **WHEN** `trellis onboard --memory on --json` runs
- **THEN** the JSON output includes the resolved memory state and
  `changed: true`, alongside every field `--json` already produced
  before this change
