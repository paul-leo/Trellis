# Proposal

## Why

The pi MCP bridge is delivered as a symlink to Trellis's bundled bridge. A
developer installation points at the repository's `dist/pi-bridge/bundle.js`,
while a packaged installation points at the installed package's bundle. After
switching installation roots, the current ownership guard treats the old
Trellis link as foreign and blocks sync, even when both bundles are byte-for-
byte identical.

## What Changes

- Allow the pi bridge adapter to adopt an existing symlink when its target is
  an identifiable `dist/pi-bridge/bundle.js` and its bytes equal the current
  Trellis bundle.
- Repair the adopted link through the normal backup/rollback path.
- Keep unrelated or modified symlinks as conflicts with no write.
- Add regression tests for development-to-package installation migration and
  for a same-shaped but different-content foreign link.

## Capabilities

### New Capabilities

- `pi-bridge-install-migration`: safe ownership adoption for equivalent
  Trellis pi bridge artifacts.

### Modified Capabilities

- None.

## Impact

- Shared symlink planning receives a narrowly-scoped adoption predicate.
- The pi adapter supplies the predicate for its bridge extension only.
- No other skill, instruction, or agent symlink changes behavior.
