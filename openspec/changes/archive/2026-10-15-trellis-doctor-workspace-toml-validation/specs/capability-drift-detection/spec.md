# Spec Delta

## ADDED Requirements

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
