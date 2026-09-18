# pi-bridge-install-migration Specification

## Purpose
Keep the pi MCP bridge usable when Trellis moves between a repository checkout
and a packaged installation, while preserving protection against foreign
symlink ownership.

## Requirements

### Requirement: Equivalent Trellis bridge links can migrate installations

When the pi bridge extension path already contains a symlink outside the
current installation root, Trellis SHALL allow repair only if the resolved
target has the `dist/pi-bridge/bundle.js` shape and its bytes exactly match
the current Trellis bridge bundle.

#### Scenario: Development link is adopted by packaged Trellis

- **WHEN** the pi extension symlink points to an equivalent Trellis bundle in
  a previous installation root
- **THEN** sync plans and applies a repair to the current bundle target

#### Scenario: Adopted repair is reversible

- **WHEN** sync repairs an equivalent previous-installation link
- **THEN** the old link target is recorded in the normal backup and rollback
  restores that target

### Requirement: Foreign pi bridge links remain protected

Trellis SHALL leave the pi bridge path as a blocking conflict when its
existing symlink target outside the current installation root is unrelated,
missing, has a different bundle shape, or has different bytes from the current
Trellis bundle. Existing current-installation links retain normal repair
behavior, including when their targets are temporarily missing.

#### Scenario: Modified bundle is not adopted

- **WHEN** the existing target ends in the bridge bundle path but its bytes
  differ from the current Trellis bundle
- **THEN** sync reports a conflict and does not replace the symlink

#### Scenario: Unrelated symlink is not adopted

- **WHEN** the existing target is outside the recognized bridge bundle shape
- **THEN** sync reports a conflict and leaves the symlink untouched
