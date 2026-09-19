# Design

## Context

`KimiCodeAdapter.plan` previously skipped native skill/instruction planning when
delivery was `mcp`. That avoided new writes but also prevented the common
symlink planner from proving and removing old Trellis-owned projections.

## Goals / Non-Goals

**Goals:**

- Make switching native/both ↔ Runtime-only converge on the next `trellis sync`.
- Reuse ownership-safe symlink removal already used by other adapters.
- Leave shared generic roots and user files alone.

**Non-Goals:**

- Do not delete physical skill directories or user-authored files.
- Do not touch Kimi's MCP config in this change.

## Decisions

The Kimi adapter always calls `planSymlinks` for its native skill and
`AGENTS.md` roots. Native/both delivery supplies canonical desired entries;
Runtime-only supplies empty desired lists. `planSymlinks` then removes only
broken/stale symlinks whose targets are under Trellis canonical, preserving
everything else.

## Risks / Trade-offs

- [Risk] Runtime-only removes a Trellis-managed AGENTS.md link
  → Mitigation: only a symlink targeting canonical is removable; user-owned
  files are reported as conflicts and left untouched.
