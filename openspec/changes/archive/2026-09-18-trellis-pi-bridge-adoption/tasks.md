# Tasks

## 1. Safe adoption logic

- [x] 1.1 Add an opt-in existing-symlink adoption predicate to the shared
      symlink planner without changing its default conflict behavior.
- [x] 1.2 Teach only the pi bridge extension to recognize equivalent
      `dist/pi-bridge/bundle.js` targets by path shape and byte equality.

## 2. Verification and local repair

- [x] 2.1 Add regression tests for equivalent installation-root migration,
      backup/repair behavior, and changed-content foreign links.
- [x] 2.2 Build/install the fixed package, run the real local `trellis sync`,
      verify pi bridge ownership and verdict, and run full validation.
