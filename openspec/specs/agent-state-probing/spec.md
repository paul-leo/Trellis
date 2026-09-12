# agent-state-probing Specification

## Purpose
TBD - created by archiving change trellis-doctor-p0. Update Purpose after archive.
## Requirements
### Requirement: MCP server handshake probing
The system SHALL determine whether a configured MCP server is reachable by
spawning it and sending a JSON-RPC `initialize` request over stdio, resolving
on the first response with `id: 1` or on process exit, whichever occurs
first, within a configurable timeout (default 10000ms).

#### Scenario: A correctly configured stdio server responds
- **WHEN** `probeMcpServer` is called against a server definition whose
  command starts a valid MCP server (e.g. `npx -y @modelcontextprotocol/server-memory`)
- **THEN** the result reports success with the server's reported `name` and
  `version` from its `initialize` response

#### Scenario: A server exits before responding
- **WHEN** the spawned process exits (crashes, missing binary, immediate
  error) before sending an `initialize` response
- **THEN** the result reports failure with the process's exit code and any
  captured stderr, not a generic timeout

#### Scenario: A server hangs
- **WHEN** the spawned process neither responds nor exits within the
  configured timeout
- **THEN** the result reports a timeout failure and the process is killed

### Requirement: Filesystem identity comparison by realpath
The system SHALL determine whether two filesystem paths refer to the same
underlying target by resolving both to their real path, not by comparing
their string paths or the byte content at each path.

#### Scenario: A symlink and its target are recognized as the same identity
- **WHEN** `isSymlinkTo` is called with a symlink path and the path it
  points to
- **THEN** it returns true

#### Scenario: Two physical copies with identical content are NOT deduplicated
- **WHEN** `realpathDedupe` is called with two ordinary (non-symlink)
  directories whose contents are byte-for-byte identical
- **THEN** it reports them as two distinct entries, mirroring how an agent's
  own discovery treats them, not as one deduplicated entry

#### Scenario: A symlink and its target are deduplicated
- **WHEN** `realpathDedupe` is called with a real directory and a symlink
  pointing at it
- **THEN** it reports exactly one entry, with both original paths recorded
  as pointing to it

### Requirement: Case-sensitive skill file detection
The system SHALL detect a skill's entry file only when its name matches
`SKILL.md` exactly, including case, and SHALL report when a candidate file
exists with the wrong case rather than silently ignoring it.

#### Scenario: Correctly cased skill file is found
- **WHEN** `findSkillFile` is called against a directory containing
  `SKILL.md`
- **THEN** it returns that path with `caseCorrect: true`

#### Scenario: Incorrectly cased skill file is flagged, not silently skipped
- **WHEN** `findSkillFile` is called against a directory containing only
  `skill.md` (lowercase)
- **THEN** it returns that path with `caseCorrect: false`, distinguishing
  this from "no skill file present at all"

### Requirement: Per-agent state snapshot
The system SHALL provide one probe per supported agent (Claude Code, Codex,
Kiro, pi) that produces an `AgentSnapshot` describing that agent's current,
real, already-installed state: presence, version, skill roots (with symlink
status and target), MCP servers as read from that agent's own persisted
static config (name, transport, handshake result), instructions file
location and symlink status, and subagent directory location and count
where applicable. Classifying a server name as colliding with a known
host-injected name is a comparison `capability-drift-detection` performs
against the static list a probe reports, not something a probe determines
itself — no probe can observe a host's runtime-only injection (e.g.
mirasim's overrides never touch the config file a probe reads).
No probe SHALL write to any file or modify any agent's configuration.

#### Scenario: Agent is not installed
- **WHEN** a probe is run for an agent whose binary/config directory is not
  present on the machine
- **THEN** the snapshot reports `present: false` and omits fields that
  require the agent to exist, rather than erroring

#### Scenario: Codex skill root reflects the realpath-based root, not the
literal configured path
- **WHEN** the Codex probe runs and Codex's own skill discovery resolves
  `~/.agents/skills` as a root
- **THEN** the snapshot's `skillRoots` entry for that root records its
  resolved realpath and whether the path itself is a symlink, so downstream
  comparison can apply realpath-based deduplication (see
  `capability-drift-detection`)

#### Scenario: pi's skill root is its confirmed discovery directory
- **WHEN** the pi probe runs
- **THEN** it reads `~/.pi/agent/skills` as pi's skill root — confirmed by
  direct source read of `@earendil-works/pi-coding-agent`'s
  `loadSkills()`/`getAgentDir()` (see design.md D5, outcome A) — and
  reports its contents the same way every other agent's skill root is
  reported (symlink status, realpath, skill names), with no special-cased
  "not comparable" marker

