## ADDED Requirements

### Requirement: Every native-config rewrite goes through the run's backup session

The system SHALL perform every native MCP config file write (Claude
Code's and Kiro's JSON merges, Codex's TOML section patch, Kiro's
approved-env-vars settings file) through the run's backup session
(`trellis-backup-rollback`) rather than writing the file directly — the
session reads and snapshots the file's current bytes (or records that it
didn't exist) before the real write happens, on every single write, with
no call site able to bypass it.

#### Scenario: A Claude Code JSON merge is snapshotted before it's rewritten
- **WHEN** `trellis mcp sync` is about to merge a new server definition
  into `~/.claude.json`, which already has real content
- **THEN** that file's current bytes are copied into the run's backup
  directory before `~/.claude.json` is overwritten with the merged result

#### Scenario: A Codex TOML section patch is snapshotted before it's rewritten
- **WHEN** `trellis mcp sync` is about to patch the MCP server section of
  `~/.codex/config.toml`
- **THEN** the file's current full bytes (not just the section being
  patched) are copied into the run's backup directory before the patched
  content is written back

#### Scenario: A first-ever write to a file that didn't exist records no prior bytes
- **WHEN** `trellis mcp sync` writes to a native config file that does
  not exist yet on this agent
- **THEN** the backup session records that the file was newly created,
  with no snapshot file since there was nothing to snapshot
