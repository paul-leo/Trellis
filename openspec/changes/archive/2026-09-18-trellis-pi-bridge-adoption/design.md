# Design

## Goals / Non-Goals

**Goals:**

- Make switching between source checkout and packaged Trellis installations
  self-healing for the pi bridge.
- Preserve the existing conservative ownership rule for normal symlinks.
- Ensure any replacement is backed up and reversible like every other sync
  write.

**Non-Goals:**

- Do not adopt arbitrary symlinks based only on their basename.
- Do not compare or adopt Skill, instruction, or other agent links.
- Do not copy the bridge into a new persistent location in this change.

## Decisions

### D1 — Adoption is an explicit symlink-planner predicate

`planSymlinks` accepts an optional predicate for exceptional artifacts. The
default remains unchanged: a symlink outside `canonicalRoot` is foreign. The
pi adapter supplies the predicate only for the bridge extension item.

### D2 — Identity requires path shape and byte equality

An existing target is adoptable only when:

1. its resolved path ends in `dist/pi-bridge/bundle.js`; and
2. the existing file bytes equal the current desired bundle bytes.

This recognizes an older Trellis installation without trusting an arbitrary
file merely because it has the expected filename.

### D3 — Adoption is still a repair

An adopted link produces the existing `create`/repair plan item with the new
desired target. `applySymlinkPlan` records the old raw link and the new link in
the normal backup manifest. Rollback therefore restores the previous link.

### D4 — Changed or unrelated links remain blocking conflicts

If the old target is missing, has another path shape, or differs in content,
the adapter retains the current conflict and remediation message. Trellis
never overwrites such a link automatically.

## Verification

- Existing equivalent checkout link is planned for repair, then points at the
  installed/current bundle after apply.
- Equivalent link writes a backup operation and rollback restores its old
  target.
- Same-shaped bundle with different bytes remains a conflict.
- Full sync, package, sandbox, and OpenSpec tests remain green.
