# Spec Delta

## Purpose

This capability makes Kimi Runtime-first delivery converge cleanly by removing
only stale native Trellis projections that would otherwise be discovered twice.

## ADDED Requirements

### Requirement: Runtime-only Kimi cleanup removes stale native Trellis projections

When Kimi delivery is `mcp`, sync SHALL remove Trellis-owned symlinks from
Kimi's native skill and instruction roots, SHALL preserve user-owned files, and
SHALL NOT touch shared `.agents/skills` content.

#### Scenario: Native Kimi skill links are removed on Runtime-first switch

- **WHEN** Kimi changes from native/both delivery to `mcp`
- **THEN** the next sync removes its Trellis-owned `~/.kimi-code/skills`
  symlinks and Kimi discovers skills through Runtime instead

#### Scenario: User-owned Kimi content is preserved

- **WHEN** a same-named Kimi skill or `AGENTS.md` is a real file or a link not
  owned by Trellis
- **THEN** sync leaves it untouched and reports a conflict if needed

#### Scenario: Shared Agent skill root is not deleted

- **WHEN** Kimi switches to Runtime-only delivery
- **THEN** `~/.agents/skills` is not modified by Kimi cleanup
