# Proposal

## Why

Kimi Runtime-first delivery disables native Skill and instruction projection,
but the adapter previously stopped planning those paths entirely. Existing
Trellis-owned symlinks therefore remained in `~/.kimi-code/skills` and could be
discovered by Kimi alongside Runtime, defeating the purpose of the mode.

## What Changes

- Always plan Kimi's managed skill and instruction roots.
- In Runtime-only delivery, desired native entries become empty so only
  Trellis-owned stale symlinks are removed.
- Preserve user-owned files and shared `~/.agents/skills` content.

## Capabilities

### New Capabilities

- `kimi-runtime-delivery-cleanup`: Idempotent cleanup of Kimi's stale native
  Trellis projections when Runtime-first delivery is selected.

### Modified Capabilities

None.

## Impact

Only Kimi's Trellis-owned native skill/instruction symlinks are affected. Kiro,
Claude, Pi, Codex, shared `.agents/skills`, canonical skills, and Kimi's MCP
config are otherwise unchanged.
