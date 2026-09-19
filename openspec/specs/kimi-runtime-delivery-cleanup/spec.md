# Kimi Runtime delivery cleanup

## Purpose

Keep Kimi Code's native projection consistent with the selected Trellis
delivery mode. Runtime-only delivery exposes Trellis capabilities through the
MCP Runtime and must not leave an older Trellis-owned native projection that
Kimi could discover a second time.

## Requirements

### Requirement: Runtime-only Kimi delivery removes stale native projections

When Kimi Code uses Runtime-only delivery, Trellis SHALL plan removal of
Trellis-owned skill symlinks under `~/.kimi-code/skills` and the Trellis-owned
`~/.kimi-code/AGENTS.md` symlink, while leaving real user files, external
symlinks, and the shared `~/.agents/skills` root untouched.

#### Scenario: Existing Trellis links converge to Runtime-only

- **WHEN** Kimi changes from native/both delivery to Runtime-only delivery
- **THEN** the next `trellis sync` removes only the stale Trellis-owned native
  links and the Kimi Runtime remains the capability entrypoint

#### Scenario: User content is preserved

- **WHEN** a real file or a symlink outside Trellis's canonical root exists in
  Kimi's native skill root
- **THEN** Trellis leaves it untouched and reports a conflict where applicable

### Requirement: Native Kimi delivery remains available

When Kimi uses native or both delivery, Trellis SHALL continue to project the
scoped canonical skills and global instructions into Kimi's native paths.

#### Scenario: Native delivery projects scoped content

- **WHEN** Kimi uses native or both delivery
- **THEN** the adapter plans the in-scope canonical skills and `AGENTS.md`
  symlink as before
