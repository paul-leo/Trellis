# capability-drift-detection Specification

## Purpose
TBD - created by archiving change trellis-doctor-p0. Update Purpose after archive.

## Requirements

### Requirement: Cross-agent snapshot comparison
The system SHALL compare `AgentSnapshot`s from all present agents pairwise
and report, for each skill name that appears in more than one agent, whether
its resolved realpath (per `agent-state-probing`'s realpath comparison) is
identical across those agents.

#### Scenario: Same skill, same source, across agents — no finding
- **WHEN** a skill named `foo` resolves to the same realpath in both the
  Claude Code and Codex snapshots
- **THEN** no drift finding is reported for `foo`

#### Scenario: Same skill name, different source, across agents — drift
- **WHEN** a skill named `foo` resolves to different realpaths in the
  Claude Code and Kiro snapshots
- **THEN** a drift finding is reported naming both agents and both resolved
  paths

### Requirement: Duplicate skill detection within a single agent
The system SHALL report, for each agent, any skill root whose discovered
entries include an ordinary (non-symlink) directory where that agent's
established pattern elsewhere is a symlink into a shared source — this is
the same class of regression documented in `docs/research.md` as previously
found and fixed by hand for Codex's `openspec-*` skills.

#### Scenario: A physical duplicate alongside symlinked skills is flagged
- **WHEN** an agent's skill root contains some skills as symlinks to a
  shared source and at least one skill as an ordinary directory with content
  identical to a symlinked entry elsewhere
- **THEN** a duplication finding is reported identifying the non-symlinked
  path

#### Scenario: All skills symlinked — no finding
- **WHEN** every skill in an agent's root is a symlink
- **THEN** no duplication finding is reported for that agent

### Requirement: MCP server name collision detection
The system SHALL report, for each agent's statically configured MCP server
names, any name that also appears in that agent's `known_host_injected` list
(per `schema/servers.example.yaml`'s convention), since a same-name
collision between a static definition and a runtime-injected one is known to
crash the entire agent process on at least one target (Codex — see
`docs/research.md`), not merely fail that one server.

When a canonical source exists (`~/.trellis/`), the `known_host_injected`
list used SHALL be read from its `mcp/servers.yaml`, not a hardcoded
default — the same source `mcp sync`'s own collision refusal
(`mcp-server-sync`) already reads. When no canonical source exists (the
original `doctor`-with-no-`.trellis/` scenario), a hardcoded fallback
list SHALL still apply so `doctor` remains fully usable without one.

#### Scenario: No collision — clean
- **WHEN** none of an agent's statically configured MCP server names appear
  in its known-host-injected list
- **THEN** no collision finding is reported

#### Scenario: Collision detected
- **WHEN** an agent's static configuration defines a server under a name
  that also appears in its known-host-injected list
- **THEN** a collision finding is reported naming the server and quoting the
  specific failure class this causes on that agent, where known (e.g.
  Codex's `url is not supported for stdio` startup failure), so the finding
  is immediately actionable rather than requiring rediscovery

#### Scenario: A canonical source's real known_host_injected list is used when present
- **WHEN** `~/.trellis/mcp/servers.yaml` exists and declares a
  `known_host_injected` list
- **THEN** `trellis doctor`'s collision check uses exactly that list,
  not the hardcoded fallback, even if the two differ

#### Scenario: No canonical source falls back to the hardcoded default
- **WHEN** `~/.trellis/` does not exist
- **THEN** `trellis doctor` still runs its collision check using the
  existing hardcoded default list, unchanged from before this
  requirement existed

### Requirement: MCP handshake probing is opt-in, never default
The system SHALL NOT spawn any configured MCP server during a default
`trellis doctor` invocation. Handshake probing (per `agent-state-probing`'s
"MCP server handshake probing" requirement) SHALL only run when explicitly
requested via `--probe-mcp`.

#### Scenario: Default invocation never spawns a server
- **WHEN** `trellis doctor` is run without `--probe-mcp`
- **THEN** every `AgentSnapshotMcpServer` entry has no `probe` result, and
  no child process is spawned for any configured MCP server

#### Scenario: `--probe-mcp` opts into live handshakes
- **WHEN** `trellis doctor --probe-mcp` is run
- **THEN** each present agent's stdio-transport servers are handshaked
  (in parallel per agent, not serially), and results populate `probe` on
  the corresponding `AgentSnapshotMcpServer` entries

### Requirement: Human-readable and machine-readable report output
The system SHALL, by default, print findings as a table using ✅ (clean),
⚠️ (finding, non-fatal to report), and ❌ (agent absent or probe failure)
per row, one row per agent or per finding as appropriate. When invoked with
`--json`, the system SHALL instead emit the full array of `AgentSnapshot`s
and findings as JSON and SHALL NOT print the human-readable table.

#### Scenario: Default invocation prints a table
- **WHEN** `trellis doctor` is run without flags
- **THEN** output is the human-readable table format

#### Scenario: JSON invocation is silent on the table
- **WHEN** `trellis doctor --json` is run
- **THEN** output is valid JSON only, parseable by a downstream consumer,
  with no table text mixed in

### Requirement: Non-zero exit on any finding
The system SHALL exit with a non-zero status code if any drift, duplication,
or collision finding exists, or if any agent's probe failed to complete
(distinct from an agent simply not being installed, which is not itself a
finding). The system SHALL exit zero only when every present agent probed
cleanly and no cross-agent finding exists.

#### Scenario: Clean run exits zero
- **WHEN** all present agents probe successfully and no findings are
  produced
- **THEN** the process exit code is 0

#### Scenario: Any finding exits non-zero
- **WHEN** at least one drift, duplication, or collision finding is produced
- **THEN** the process exit code is non-zero, making `trellis doctor`
  usable as a CI or pre-commit gate

### Requirement: Doctor includes ZCode static state

The system SHALL include a present ZCode snapshot in cross-agent Skill,
MCP-collision, parse-diagnostic, and canonical-runtime-drift checks, using
only its static profile configuration.

#### Scenario: ZCode Runtime entry drifts from canonical
- **WHEN** canonical expects the ZCode Runtime entry and the selected ZCode
  configuration no longer contains it
- **THEN** `trellis doctor` reports a ZCode runtime-drift finding

### Requirement: Workspace Codex config TOML syntax is validated and reported
When a workspace layer is in scope and the workspace root contains `.codex/config.toml`, the system SHALL validate that the file is syntactically parseable TOML before attempting any entry extraction from it. A parse failure SHALL be reported as a dedicated finding that includes the parser's line and column and the reason, and SHALL be reported even when the file contains no Trellis-rendered entry at all (i.e. ownership by Trellis is irrelevant to this check). The finding SHALL make clear that the file was not written by Trellis and SHALL direct the user to fix it by hand; the system SHALL NOT modify, repair, or rewrite the file.

The system SHALL include this finding among those that make `trellis doctor` exit non-zero, because a Codex config that cannot be parsed will fail Codex's own startup regardless of which agent owns the entries.

#### Scenario: Malformed project Codex config is reported even without Trellis ownership
- **WHEN** a workspace is in scope, `.codex/config.toml` at the workspace root contains a TOML syntax error (e.g. a duplicate `enabled` key inside one `[mcp_servers.*]` table), and no entry in the file is Trellis-rendered
- **THEN** `trellis doctor` reports a finding naming the file, the parser's line/column, and the reason, and exits non-zero

#### Scenario: Valid project Codex config produces no extra finding
- **WHEN** a workspace is in scope and `.codex/config.toml` parses cleanly
- **THEN** no workspace TOML finding is produced, and any unmigrated-entry checking proceeds against the parsed section headers as before

#### Scenario: Finding runs without a global canonical source
- **WHEN** `~/.trellis/` does not exist but the current directory is inside a workspace with `.agents/` and a broken `.codex/config.toml`
- **THEN** `trellis doctor` still reports the workspace TOML finding

### Requirement: Unreadable workspace Codex config is not mistaken for "all unmigrated"
When the workspace's `.codex/config.toml` cannot be inspected — either because TOML parsing failed or because entry-name extraction cannot proceed — the system SHALL NOT treat every entry in that file as an unmigrated Trellis entry. The unmigrated hint for that file SHALL either be omitted or explicitly marked as "could not inspect", so the user is not misled into thinking the whole file needs `migrate --workspace` when the actual problem is a syntax error.

#### Scenario: Parse failure suppresses misleading unmigrated hint
- **WHEN** the workspace `.codex/config.toml` has a TOML syntax error
- **THEN** the workspace doctor section does not list any of the file's entries as unmigrated; the only workspace finding for that file is the TOML syntax finding
